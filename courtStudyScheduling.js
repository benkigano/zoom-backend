import {
  resolveCommunityHostedStudyDuration,
} from "./courtStudyDuration.js";

export function resolveCourtStudyScheduleDuration(
  request,
  durationOverride
) {
  const intendedDuration =
    resolveCommunityHostedStudyDuration(request);

  if (durationOverride === undefined || durationOverride === null) {
    return intendedDuration;
  }

  const normalizedOverride = Number(durationOverride);

  if (
    normalizedOverride !== 40 ||
    intendedDuration <= 40
  ) {
    throw new Error(
      "Only an eligible Zoom Basic reduction to 40 minutes is allowed."
    );
  }

  return normalizedOverride;
}

export function createUtcScheduleWindow(
  preferredStart,
  durationMinutes
) {
  const start = new Date(preferredStart);

  if (
    Number.isNaN(start.getTime()) ||
    !Number.isInteger(durationMinutes) ||
    durationMinutes <= 0
  ) {
    throw new Error("A valid start time and duration are required.");
  }

  return {
    scheduledStart: start.toISOString(),
    scheduledEnd: new Date(
      start.getTime() + durationMinutes * 60 * 1000
    ).toISOString(),
  };
}

export function getScheduledDurationMinutes(
  scheduledStart,
  scheduledEnd
) {
  const start = new Date(scheduledStart);
  const end = new Date(scheduledEnd);
  const difference = end.getTime() - start.getTime();

  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    difference <= 0 ||
    difference % 60000 !== 0
  ) {
    throw new Error(
      "Scheduled start and end must define a positive whole-minute duration."
    );
  }

  return difference / 60000;
}

export function resolveZoomCreationDisposition({
  requestStatus,
  meetingStatus,
  zoomMeetingId,
  zoomJoinUrl,
  zoomRegistrationUrl,
}) {
  if (zoomMeetingId) {
    return "EXISTS";
  }

  if (zoomJoinUrl || zoomRegistrationUrl) {
    return "IN_PROGRESS_OR_RECONCILIATION_REQUIRED";
  }

  if (requestStatus !== "SCHEDULED") {
    return "INELIGIBLE";
  }

  if (meetingStatus === "CREATING") {
    return "IN_PROGRESS_OR_RECONCILIATION_REQUIRED";
  }

  if (
    meetingStatus === "SCHEDULED" ||
    meetingStatus === "FAILED"
  ) {
    return "CLAIM";
  }

  return "INELIGIBLE";
}

export async function createCourtStudyMeetingWithClaim({
  claim,
  createMeeting,
}) {
  const claimResult = await claim();

  if (claimResult?.count !== 1) {
    const error = new Error(
      "The Court Study request changed before it could be scheduled."
    );
    error.code = "COURT_STUDY_SCHEDULE_CLAIM_LOST";
    throw error;
  }

  return createMeeting();
}

export async function resolveCourtStudyInvitationToken({
  currentToken,
  createToken,
  claimToken,
  loadToken,
}) {
  if (currentToken) {
    return currentToken;
  }

  const candidateToken = createToken();
  const claimResult = await claimToken(candidateToken);

  if (claimResult?.count === 1) {
    return candidateToken;
  }

  const persistedToken = await loadToken();

  if (!persistedToken) {
    throw new Error(
      "The organizer invitation token could not be saved or recovered."
    );
  }

  return persistedToken;
}

export function formatCourtStudySetupFailure({
  studyName,
  failureType,
  durationMinutes,
}) {
  const name = studyName || "Court Study";
  const duration = Number.isInteger(durationMinutes)
    ? ` for ${durationMinutes} minutes`
    : "";

  switch (failureType) {
    case "SCHEDULING_FAILED":
      return `We could not schedule your ${name}, so this attempt did not create a Zoom meeting. Do not submit this choice again; please contact Court of Compassion using your study approval information.`;
    case "ZOOM_NOT_CREATED":
      return `Your ${name} is scheduled, but Zoom did not create its meeting. Court staff must review the setup before it continues. Please do not resubmit this choice.`;
    case "ZOOM_OUTCOME_UNCERTAIN":
      return `Your ${name} is scheduled, but we could not confirm whether Zoom created the meeting. Do not retry or create another meeting; Court staff must reconcile it first.`;
    case "INVITATION_NOT_SENT":
      return `Your ${name} Zoom meeting was created${duration}, but the Session Ready invitation was not sent. The meeting is preserved; Court staff must review and recover invitation delivery only.`;
    case "INVITATION_OUTCOME_UNCERTAIN":
      return `Your ${name} Zoom meeting was created${duration}, but invitation delivery is uncertain. Do not resend or create another meeting; Court staff must verify delivery before recovering the invitation only.`;
    default:
      return `We could not confirm that your ${name} setup is complete. Please do not retry; Court staff must review the study before taking another action.`;
  }
}

export async function runZoomCreationWithClaim({
  claim,
  create,
  persist,
  release,
  markDefinitiveFailure,
}) {
  const claimed = await claim();

  if (!claimed) {
    return { state: "NOT_CLAIMED" };
  }

  let externalRequestDispatched = false;
  const markExternalRequestDispatched = () => {
    externalRequestDispatched = true;
  };

  try {
    const creationResult = await create(
      markExternalRequestDispatched
    );

    if (!creationResult?.success) {
      if (!externalRequestDispatched) {
        await release();
        return {
          state: "PREPARATION_FAILED",
          result: creationResult,
        };
      }

      if (creationResult.definitive) {
        await markDefinitiveFailure();
        return {
          state: "DEFINITIVE_FAILURE",
          result: creationResult,
        };
      }

      return {
        state: "AMBIGUOUS",
        result: creationResult,
      };
    }

    await persist(creationResult.value);

    return {
      state: "CREATED",
      value: creationResult.value,
    };
  } catch (error) {
    if (!externalRequestDispatched) {
      await release();
      return {
        state: "PREPARATION_FAILED",
        error,
      };
    }

    return {
      state: "AMBIGUOUS",
      error,
    };
  }
}

export async function runCourtStudySetupStages({
  schedule,
  createZoom,
  sendInvitation,
}) {
  const scheduleResult = await schedule();

  if (!scheduleResult?.success) {
    return {
      success: false,
      failedStage: "SCHEDULING",
      failureType: "SCHEDULING_FAILED",
      stageResult: scheduleResult,
      error:
        scheduleResult?.error ||
        scheduleResult?.responseBody?.error ||
        "Court Study scheduling failed.",
    };
  }

  const zoomResult = await createZoom();
  const zoomBody =
    zoomResult?.responseBody ?? zoomResult;

  if (!zoomBody?.success) {
    const failureType =
      zoomBody?.reconciliationRequired
        ? "ZOOM_OUTCOME_UNCERTAIN"
        : zoomBody?.noMeetingCreated === true ||
            Number(zoomResult?.statusCode) < 500
          ? "ZOOM_NOT_CREATED"
          : "ZOOM_OUTCOME_UNCERTAIN";

    return {
      success: false,
      failedStage: "ZOOM_CREATION",
      failureType,
      stageResult: zoomResult,
      error:
        zoomBody?.error ||
        "Court Study Zoom creation failed.",
    };
  }

  if (
    scheduleResult?.meeting?.invitationSentAt
  ) {
    return {
      success: true,
      scheduleResult,
      zoomResult,
      invitationResult: {
        success: true,
        responseBody: {
          success: true,
          skipped: true,
          message:
            "The organizer invitation was already recorded as sent.",
        },
      },
    };
  }

  const invitationResult = await sendInvitation();
  const invitationBody =
    invitationResult?.responseBody ?? invitationResult;

  if (
    !invitationResult?.success ||
    !invitationBody?.success
  ) {
    const failureType =
      invitationBody?.deliveryMayHaveOccurred
        ? "INVITATION_OUTCOME_UNCERTAIN"
        : "INVITATION_NOT_SENT";

    return {
      success: false,
      failedStage: "INVITATION",
      failureType,
      stageResult: invitationResult,
      error:
        invitationBody?.error ||
        "Court Study invitation delivery failed.",
    };
  }

  return {
    success: true,
    scheduleResult,
    zoomResult,
    invitationResult,
  };
}
