import {
  normalizeMembershipEmail,
  normalizeMembershipPlan,
} from "./guards.js";

const COURT_STUDY_MEMBERSHIP_PLANS = new Set([
  "BASIC",
  "CHURCH_INDIVIDUAL",
  "CHURCH_GROUP",
]);

function buildMembershipVerificationUrl(
  siteOrigin,
  token,
  continuation = null
) {
  const url = new URL("/membership/verify", siteOrigin);
  url.searchParams.set("token", token);

  if (continuation) {
    const requestId = String(continuation.requestId || "").trim();
    const continuationToken = String(continuation.token || "").trim();

    if (!requestId || !continuationToken) {
      throw new Error("Invalid Court Study continuation context");
    }

    url.hash = new URLSearchParams({
      courtStudyRequestId: requestId,
      courtStudyToken: continuationToken,
    }).toString();
  }

  return url.toString();
}

async function releaseCourtStudyRequestForActiveSubscriber({
  courtStudyRequestId,
  prisma,
  isActiveSubscriberEmail,
  sendApprovalEmail,
  logError = console.error,
}) {
  const requestId = String(courtStudyRequestId || "").trim();

  if (!requestId) {
    return { released: false, reason: "missing_request_id" };
  }

  const request = await prisma.courtStudyRequest.findUnique({
    where: { id: requestId },
  });

  if (!request) {
    throw new Error(
      `Court Study request not found for subscription checkout: ${requestId}`
    );
  }

  const status = String(request.status || "").trim().toUpperCase();
  const meetingFormat = String(request.meetingFormat || "")
    .trim()
    .toUpperCase();

  if (status !== "PENDING") {
    return {
      released: false,
      reason: "request_not_pending",
      status,
      meetingFormat,
    };
  }

  if (meetingFormat !== "COMMUNITY_HOSTED") {
    throw new Error(
      `Court Study subscription request ${requestId} is not COMMUNITY_HOSTED.`
    );
  }

  const organizerEmail = String(
    request.organizerEmail || request.pastorEmail || ""
  )
    .trim()
    .toLowerCase();
  if (!organizerEmail) {
    throw new Error(
      `Court Study request ${requestId} does not have an organizer email.`
    );
  }

  if (!(await isActiveSubscriberEmail(organizerEmail))) {
    return { released: false, reason: "subscription_not_active" };
  }

  const update = await prisma.courtStudyRequest.updateMany({
    where: {
      id: requestId,
      status: request.status,
    },
    data: { status: "APPROVED" },
  });

  if (update.count !== 1) {
    const currentRequest = await prisma.courtStudyRequest.findUnique({
      where: { id: requestId },
      select: { status: true, meetingFormat: true },
    });

    if (!currentRequest) {
      throw new Error(
        `Court Study request not found for subscription checkout: ${requestId}`
      );
    }

    return {
      released: false,
      reason: "request_not_pending",
      status: String(currentRequest.status || "").trim().toUpperCase(),
      meetingFormat: String(currentRequest.meetingFormat || "")
        .trim()
        .toUpperCase(),
    };
  }

  let zoomConnectionEmailSent = false;
  let zoomConnectionEmailError = null;

  try {
    await sendApprovalEmail({
      requestId,
      organizerName: request.organizerName || request.pastorName || "",
      organizerEmail: request.organizerEmail || request.pastorEmail || "",
      hostGroupName: request.hostGroupName || request.churchName || "",
      preferredStart: request.preferredStart,
      timezone: request.timezone,
    });
    zoomConnectionEmailSent = true;
  } catch (emailError) {
    zoomConnectionEmailError = String(emailError?.message || emailError);
    logError(
      "❌ SUBSCRIBER COURT STUDY ZOOM APPROVAL EMAIL FAILED:",
      requestId,
      emailError
    );
  }

  return {
    released: true,
    status: "APPROVED",
    zoomConnectionEmailSent,
    zoomConnectionEmailError,
  };
}

function hasCallerSuppliedIdentity(body) {
  return ["email", "memberEmail", "memberId", "organizerEmail"].some(
    (key) => Object.prototype.hasOwnProperty.call(body || {}, key)
  );
}

function createCourtStudyMembershipEnrollmentHandler({
  prisma,
  verifyContinuationToken,
  isActiveSubscriberEmail,
  requestMembershipVerification,
  logError = console.error,
}) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");

    const requestId = String(req.body?.requestId || "").trim();
    const token = String(req.body?.token || "").trim();
    const rawPlan = req.body?.plan;
    const plan = normalizeMembershipPlan(rawPlan);

    if (
      !requestId ||
      !token ||
      typeof rawPlan !== "string" ||
      !rawPlan.trim() ||
      !plan ||
      !COURT_STUDY_MEMBERSHIP_PLANS.has(plan) ||
      hasCallerSuppliedIdentity(req.body)
    ) {
      return res.status(400).json({
        success: false,
        error: "A valid Court Study continuation and membership plan are required.",
      });
    }

    if (!verifyContinuationToken(requestId, token)) {
      return res.status(403).json({
        success: false,
        error: "Invalid Court Study continuation link.",
      });
    }

    try {
      const request = await prisma.courtStudyRequest.findUnique({
        where: { id: requestId },
        select: {
          id: true,
          status: true,
          meetingFormat: true,
          organizerEmail: true,
          pastorEmail: true,
        },
      });

      if (!request) {
        return res.status(404).json({
          success: false,
          error: "Court Study request not found.",
        });
      }

      if (String(request.status || "").trim().toUpperCase() !== "PENDING") {
        return res.status(409).json({
          success: false,
          error: "This Court Study request is no longer awaiting membership.",
        });
      }

      if (
        String(request.meetingFormat || "").trim().toUpperCase() !==
        "COMMUNITY_HOSTED"
      ) {
        return res.status(400).json({
          success: false,
          error: "Membership continuation is only available for community-hosted Court Study requests.",
        });
      }

      const email = normalizeMembershipEmail(
        request.organizerEmail || request.pastorEmail
      );
      if (!email) {
        return res.status(409).json({
          success: false,
          error: "The Court Study request has no eligible organizer email.",
        });
      }

      if (await isActiveSubscriberEmail(email)) {
        return res.status(200).json({
          success: true,
          status: "ACTIVE_SUBSCRIBER",
          requestId,
        });
      }

      const verificationStarted = await requestMembershipVerification(email, plan, {
        requestId,
        token,
      });

      if (!verificationStarted) {
        return res.status(409).json({
          success: false,
          status: "MEMBERSHIP_ENROLLMENT_UNAVAILABLE",
          error: "Membership enrollment cannot be started for this request right now.",
        });
      }

      return res.status(200).json({
        success: true,
        status: "VERIFICATION_REQUIRED",
      });
    } catch (error) {
      logError(
        "Court Study membership enrollment failed:",
        error?.code || "UNKNOWN"
      );
      return res.status(503).json({
        success: false,
        error: "Court Study membership enrollment is temporarily unavailable.",
      });
    }
  };
}

function createCourtStudyMembershipContinuationHandler({
  prisma,
  verifyContinuationToken,
  isActiveSubscriberEmail,
  sendApprovalEmail,
  logError = console.error,
}) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");

    const requestId = String(req.body?.requestId || "").trim();
    const token = String(req.body?.token || "").trim();

    if (
      !requestId ||
      !token ||
      hasCallerSuppliedIdentity(req.body)
    ) {
      return res.status(400).json({
        success: false,
        error: "A valid Court Study continuation is required.",
      });
    }

    if (!verifyContinuationToken(requestId, token)) {
      return res.status(403).json({
        success: false,
        error: "Invalid Court Study continuation link.",
      });
    }

    try {
      const result = await releaseCourtStudyRequestForActiveSubscriber({
        courtStudyRequestId: requestId,
        prisma,
        isActiveSubscriberEmail,
        sendApprovalEmail,
        logError,
      });

      if (
        result.released ||
        (result.reason === "request_not_pending" &&
          result.status === "APPROVED" &&
          result.meetingFormat === "COMMUNITY_HOSTED")
      ) {
        return res.status(200).json({
          success: true,
          requestId,
          status: "APPROVED",
          zoomReady: true,
        });
      }

      if (result.reason === "subscription_not_active") {
        return res.status(409).json({
          success: false,
          requestId,
          status: "MEMBERSHIP_NOT_ACTIVE",
          zoomReady: false,
        });
      }

      return res.status(409).json({
        success: false,
        requestId,
        status: "REQUEST_NOT_ELIGIBLE",
        zoomReady: false,
      });
    } catch (error) {
      logError(
        "Court Study membership continuation failed:",
        error?.code || "UNKNOWN"
      );
      return res.status(503).json({
        success: false,
        error: "Unable to continue the Court Study request.",
      });
    }
  };
}

export {
  buildMembershipVerificationUrl,
  createCourtStudyMembershipEnrollmentHandler,
  createCourtStudyMembershipContinuationHandler,
  releaseCourtStudyRequestForActiveSubscriber,
};
