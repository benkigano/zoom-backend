import crypto from "node:crypto";

const BOOK_STUDY_DURATIONS = new Set([30, 40, 45, 60, 90]);
const BASIC_DURATION_AUTHORIZATION_TTL_MS = 15 * 60 * 1000;
const COMMUNITY_STUDY_INVITATION_TOKEN_PREFIX =
  "coc-study-v1.";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeOAuthEnvironment(value) {
  return normalizeText(value || "PRODUCTION").toUpperCase();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeNullableText(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeCanonicalTimestamp(value) {
  const normalized = normalizeNullableText(value);

  if (normalized === null) {
    return null;
  }

  const timestamp =
    value instanceof Date ? value : new Date(normalized);

  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("Invalid community study authorization timestamp.");
  }

  return timestamp.toISOString();
}

function secureStringEquals(left, right) {
  const leftBuffer = Buffer.from(String(left), "utf8");
  const rightBuffer = Buffer.from(String(right), "utf8");

  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function resolveCommunityHostedStudyDuration(request) {
  if (
    normalizeText(request?.meetingFormat).toUpperCase() !==
    "COMMUNITY_HOSTED"
  ) {
    throw new Error(
      "Duration policy applies only to community-hosted study requests."
    );
  }

  const studyFocusType = normalizeText(
    request?.studyFocusType
  ).toUpperCase();

  if (
    studyFocusType === "RULES_OF_PROCEDURE" ||
    studyFocusType === "INTERVIEW_RECORDING"
  ) {
    return 60;
  }

  if (studyFocusType === "BOOK_STUDY") {
    const durationMinutes = Number(request?.durationMinutes);

    if (!BOOK_STUDY_DURATIONS.has(durationMinutes)) {
      throw new Error(
        "Book Study duration must be 30, 40, 45, 60, or 90 minutes."
      );
    }

    return durationMinutes;
  }

  throw new Error("Unsupported community-hosted study type.");
}

export function classifyZoomAccountType(type) {
  const normalizedType =
    typeof type === "string" ? type.trim() : type;

  if (normalizedType === 1 || normalizedType === "1") {
    return "BASIC";
  }

  if (normalizedType === 2 || normalizedType === "2") {
    return "PAID";
  }

  return "UNKNOWN";
}

export function requiresZoomBasicDurationChoice(
  request,
  accountType
) {
  const durationMinutes =
    resolveCommunityHostedStudyDuration(request);

  return accountType === "BASIC" && durationMinutes > 40;
}

export function resolveCommunityHostedZoomDurationDecision(
  request,
  accountType
) {
  const requestedDurationMinutes =
    resolveCommunityHostedStudyDuration(request);

  if (accountType !== "BASIC" && accountType !== "PAID") {
    throw new Error(
      "The Zoom account type is not verified for meeting creation."
    );
  }

  const requiresBasicDurationChoice =
    accountType === "BASIC" &&
    requestedDurationMinutes > 40;

  return {
    requestedDurationMinutes,
    requiresBasicDurationChoice,
    scheduledDurationMinutes: requiresBasicDurationChoice
      ? null
      : requestedDurationMinutes,
  };
}

export function resolveCommunityStudyZoomAuthorizationMode(
  request,
  { studyRecheck = false } = {}
) {
  if (
    normalizeText(request?.meetingFormat).toUpperCase() !==
    "COMMUNITY_HOSTED"
  ) {
    throw new Error(
      "Zoom authorization is only available for community-hosted studies."
    );
  }

  if (request.courtStudyMeeting) {
    throw new Error(
      "A Zoom meeting already exists for this study request."
    );
  }

  if (studyRecheck) {
    return {
      mode: "STUDY_RECHECK",
      requestedDurationMinutes:
        resolveBasicDurationContinuationRequest(request),
    };
  }

  if (
    normalizeText(request.status).toUpperCase() !==
    "APPROVED"
  ) {
    throw new Error(
      "This study is not currently approved for initial Zoom authorization."
    );
  }

  return {
    mode: "INITIAL",
    requestedDurationMinutes:
      resolveCommunityHostedStudyDuration(request),
  };
}

const COMMUNITY_STUDY_CONTEXT_FIELDS = [
  "requestId",
  "organizerEmail",
  "oauthEnvironment",
  "authorizationMode",
  "invitationIdentity",
  "studyFocusType",
  "requestedDurationMinutes",
  "requestOAuthEnvironment",
  "preferredStart",
  "timezone",
  "expectedRequestStatus",
  "hostingMode",
  "meetingId",
];

function normalizeCommunityStudyOAuthContext(context) {
  if (
    !context ||
    typeof context !== "object" ||
    Array.isArray(context) ||
    Object.keys(context).length !==
      COMMUNITY_STUDY_CONTEXT_FIELDS.length ||
    COMMUNITY_STUDY_CONTEXT_FIELDS.some(
      (field) =>
        !Object.prototype.hasOwnProperty.call(context, field)
    )
  ) {
    throw new Error(
      "Community Study OAuth context is incomplete."
    );
  }

  const invitationIdentity = context.invitationIdentity;

  if (
    !invitationIdentity ||
    typeof invitationIdentity !== "object" ||
    Array.isArray(invitationIdentity) ||
    Object.keys(invitationIdentity).length !== 3 ||
    !Object.prototype.hasOwnProperty.call(
      invitationIdentity,
      "organizerEmail"
    ) ||
    !Object.prototype.hasOwnProperty.call(
      invitationIdentity,
      "oauthEnvironment"
    ) ||
    !Object.prototype.hasOwnProperty.call(
      invitationIdentity,
      "tokenHash"
    )
  ) {
    throw new Error(
      "Community Study OAuth invitation identity is incomplete."
    );
  }

  const normalizedContext = {
    requestId: normalizeText(context.requestId),
    organizerEmail: normalizeEmail(context.organizerEmail),
    oauthEnvironment: normalizeOAuthEnvironment(
      context.oauthEnvironment
    ),
    authorizationMode: normalizeText(
      context.authorizationMode
    ).toUpperCase(),
    invitationIdentity: {
      organizerEmail: normalizeEmail(
        invitationIdentity.organizerEmail
      ),
      oauthEnvironment: normalizeOAuthEnvironment(
        invitationIdentity.oauthEnvironment
      ),
      tokenHash: normalizeText(
        invitationIdentity.tokenHash
      ).toLowerCase(),
    },
    studyFocusType: normalizeText(
      context.studyFocusType
    ).toUpperCase(),
    requestedDurationMinutes: Number(
      context.requestedDurationMinutes
    ),
    requestOAuthEnvironment: normalizeNullableText(
      context.requestOAuthEnvironment
    )?.toUpperCase() ?? null,
    preferredStart: normalizeCanonicalTimestamp(
      context.preferredStart
    ),
    timezone: normalizeNullableText(context.timezone),
    expectedRequestStatus: normalizeText(
      context.expectedRequestStatus
    ).toUpperCase(),
    hostingMode: normalizeText(context.hostingMode).toUpperCase(),
    meetingId: normalizeNullableText(context.meetingId),
  };

  if (
    !normalizedContext.requestId ||
    !normalizedContext.organizerEmail ||
    !normalizedContext.studyFocusType ||
    !Number.isInteger(
      normalizedContext.requestedDurationMinutes
    ) ||
    normalizedContext.requestedDurationMinutes <= 0 ||
    !/^[a-f0-9]{64}$/.test(
      normalizedContext.invitationIdentity.tokenHash
    ) ||
    normalizedContext.invitationIdentity.organizerEmail !==
      normalizedContext.organizerEmail ||
    normalizedContext.invitationIdentity.oauthEnvironment !==
      normalizedContext.oauthEnvironment ||
    normalizedContext.hostingMode !== "COMMUNITY_HOSTED" ||
    !["INITIAL", "STUDY_RECHECK"].includes(
      normalizedContext.authorizationMode
    ) ||
    normalizedContext.expectedRequestStatus !==
      (normalizedContext.authorizationMode === "INITIAL"
        ? "APPROVED"
        : "ZOOM_CONNECTED")
  ) {
    throw new Error(
      "Community Study OAuth context is invalid."
    );
  }

  if (
    normalizedContext.requestOAuthEnvironment !== null &&
    normalizedContext.requestOAuthEnvironment !== "PRODUCTION" &&
    normalizedContext.requestOAuthEnvironment !== "DEVELOPMENT"
  ) {
    throw new Error(
      "Community Study request has an invalid Zoom OAuth environment."
    );
  }

  return normalizedContext;
}

export function createCommunityStudyOAuthRequestContext(
  request,
  {
    oauthEnvironment,
    invitationToken,
    studyRecheck,
  }
) {
  const authorization =
    resolveCommunityStudyZoomAuthorizationMode(
      request,
      { studyRecheck }
    );
  const normalizedOrganizerEmail = normalizeEmail(
    request.organizerEmail
  );
  const normalizedOAuthEnvironment =
    normalizeOAuthEnvironment(oauthEnvironment);

  return normalizeCommunityStudyOAuthContext({
    requestId: request.id,
    organizerEmail: normalizedOrganizerEmail,
    oauthEnvironment: normalizedOAuthEnvironment,
    authorizationMode: authorization.mode,
    invitationIdentity: {
      organizerEmail: normalizedOrganizerEmail,
      oauthEnvironment: normalizedOAuthEnvironment,
      tokenHash: crypto
        .createHash("sha256")
        .update(normalizeText(invitationToken), "utf8")
        .digest("hex"),
    },
    studyFocusType: request.studyFocusType,
    requestedDurationMinutes:
      authorization.requestedDurationMinutes,
    requestOAuthEnvironment: request.zoomOAuthEnvironment,
    preferredStart: request.preferredStart,
    timezone: request.timezone,
    expectedRequestStatus: request.status,
    hostingMode: request.meetingFormat,
    meetingId: request.courtStudyMeeting?.id,
  });
}

export function matchesCommunityStudyOAuthRequestContext(
  state,
  request
) {
  try {
    const expectedContext =
      createCommunityStudyOAuthRequestContext(request, {
        oauthEnvironment: state?.oauthEnvironment,
        invitationToken: state?.invitationToken,
        studyRecheck: state?.studyRecheck,
      });
    const suppliedContext =
      normalizeCommunityStudyOAuthContext(
        state?.studyContext
      );

    return (
      JSON.stringify(suppliedContext) ===
      JSON.stringify(expectedContext)
    );
  } catch {
    return false;
  }
}

export function hasConflictingOAuthCallbackRouting(state) {
  const hasOwn = (field) =>
    Object.prototype.hasOwnProperty.call(state || {}, field);
  const hasStudyState =
    Boolean(
      normalizeText(state?.requestId) ||
        normalizeText(state?.studyAuthorizationSignature)
    ) ||
    hasOwn("studyRecheck") ||
    hasOwn("studyContext");
  const hasStudyInvitation =
    normalizeText(state?.invitationToken).startsWith(
      COMMUNITY_STUDY_INVITATION_TOKEN_PREFIX
    );
  const hasChurchContact = Boolean(
    normalizeText(state?.churchContactId)
  );

  if (hasStudyInvitation !== hasStudyState) {
    return true;
  }

  if (hasStudyState) {
    return [
      "reauthOnly",
      "reviewerFlow",
      "churchContactId",
    ].some(hasOwn);
  }

  if (hasChurchContact) {
    return (
      hasOwn("reauthOnly") ||
      hasOwn("reviewerFlow") ||
      hasOwn("requestId") ||
      hasOwn("studyRecheck") ||
      hasOwn("studyContext") ||
      hasOwn("studyAuthorizationSignature")
    );
  }

  return (
    state?.reviewerFlow === true &&
    state?.reauthOnly !== true
  );
}

export function normalizeZoomIdentityEmail(email) {
  const normalized = normalizeEmail(email);
  const atIndex = normalized.lastIndexOf("@");

  if (atIndex <= 0) {
    return normalized;
  }

  const localPart = normalized.slice(0, atIndex);
  const domainPart = normalized.slice(atIndex + 1);

  if (domainPart === "gmail.com" || domainPart === "googlemail.com") {
    return `${localPart.split("+")[0]}@gmail.com`;
  }

  return normalized;
}

export function resolveBasicDurationContinuationRequest(request) {
  if (!request) {
    throw new Error("Study request not found.");
  }

  if (
    normalizeText(request.status).toUpperCase() !==
    "ZOOM_CONNECTED"
  ) {
    throw new Error(
      "This study is not currently waiting for the Zoom Basic duration decision."
    );
  }

  if (request.courtStudyMeeting) {
    throw new Error(
      "A meeting has already been created for this study request."
    );
  }

  const durationMinutes =
    resolveCommunityHostedStudyDuration(request);

  if (durationMinutes <= 40) {
    throw new Error(
      "This study does not require the Zoom Basic 40-minute adjustment."
    );
  }

  return durationMinutes;
}

export function createBasicDurationAuthorizationToken({
  requestId,
  organizerEmail,
  oauthEnvironment,
  zoomUserId,
  secret,
  now = Date.now(),
  expiresInMs = BASIC_DURATION_AUTHORIZATION_TTL_MS,
}) {
  const normalizedRequestId = normalizeText(requestId);
  const normalizedOrganizerEmail = normalizeEmail(organizerEmail);
  const normalizedOAuthEnvironment =
    normalizeOAuthEnvironment(oauthEnvironment);
  const normalizedZoomUserId = normalizeText(zoomUserId);
  const normalizedSecret = normalizeText(secret);

  if (
    !normalizedRequestId ||
    !normalizedOrganizerEmail ||
    !normalizedZoomUserId ||
    !normalizedSecret
  ) {
    throw new Error(
      "Basic duration authorization context is incomplete."
    );
  }

  if (
    normalizedOAuthEnvironment !== "PRODUCTION" &&
    normalizedOAuthEnvironment !== "DEVELOPMENT"
  ) {
    throw new Error("Invalid Zoom OAuth environment.");
  }

  if (
    !Number.isFinite(now) ||
    !Number.isFinite(expiresInMs) ||
    expiresInMs <= 0 ||
    expiresInMs > BASIC_DURATION_AUTHORIZATION_TTL_MS
  ) {
    throw new Error("Invalid Basic duration authorization lifetime.");
  }

  const payload = {
    purpose: "zoom-basic-duration",
    requestId: normalizedRequestId,
    organizerEmail: normalizedOrganizerEmail,
    oauthEnvironment: normalizedOAuthEnvironment,
    zoomUserId: normalizedZoomUserId,
    issuedAt: now,
    expiresAt: now + expiresInMs,
    nonce: crypto.randomBytes(16).toString("base64url"),
  };
  const encodedPayload = Buffer.from(
    JSON.stringify(payload),
    "utf8"
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", normalizedSecret)
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

function getCommunityStudyOAuthStatePayload({
  requestId,
  organizerEmail,
  oauthEnvironment,
  invitationToken,
  studyRecheck,
  studyContext,
}) {
  const normalizedRequestId = normalizeText(requestId);
  const normalizedOrganizerEmail = normalizeEmail(organizerEmail);
  const normalizedOAuthEnvironment =
    normalizeOAuthEnvironment(oauthEnvironment);
  const normalizedInvitationToken =
    normalizeText(invitationToken);
  const normalizedStudyContext =
    normalizeCommunityStudyOAuthContext(studyContext);
  const invitationTokenHash = crypto
    .createHash("sha256")
    .update(normalizedInvitationToken, "utf8")
    .digest("hex");

  if (
    !normalizedRequestId ||
    !normalizedOrganizerEmail ||
    !normalizedInvitationToken ||
    typeof studyRecheck !== "boolean" ||
    (normalizedOAuthEnvironment !== "PRODUCTION" &&
      normalizedOAuthEnvironment !== "DEVELOPMENT")
  ) {
    throw new Error(
      "Community Study OAuth state context is incomplete."
    );
  }

  if (
    normalizedStudyContext.requestId !==
      normalizedRequestId ||
    normalizedStudyContext.organizerEmail !==
      normalizedOrganizerEmail ||
    normalizedStudyContext.oauthEnvironment !==
      normalizedOAuthEnvironment ||
    normalizedStudyContext.authorizationMode !==
      (studyRecheck ? "STUDY_RECHECK" : "INITIAL") ||
    normalizedStudyContext.invitationIdentity.tokenHash !==
      invitationTokenHash
  ) {
    throw new Error(
      "Community Study OAuth state does not match its signed context."
    );
  }

  return JSON.stringify({
    purpose: "community-study-zoom-authorization",
    requestId: normalizedRequestId,
    organizerEmail: normalizedOrganizerEmail,
    oauthEnvironment: normalizedOAuthEnvironment,
    invitationTokenHash,
    studyRecheck,
    studyContext: normalizedStudyContext,
  });
}

export function createCommunityStudyOAuthStateSignature({
  requestId,
  organizerEmail,
  oauthEnvironment,
  invitationToken,
  studyRecheck,
  studyContext,
  secret,
}) {
  const normalizedSecret = normalizeText(secret);

  if (!normalizedSecret) {
    throw new Error("ADMIN_SESSION_SECRET is not configured.");
  }

  return crypto
    .createHmac("sha256", normalizedSecret)
    .update(
      getCommunityStudyOAuthStatePayload({
        requestId,
        organizerEmail,
        oauthEnvironment,
        invitationToken,
        studyRecheck,
        studyContext,
      })
    )
    .digest("base64url");
}

export function verifyCommunityStudyOAuthStateSignature(
  state,
  secret
) {
  try {
    const suppliedSignature = normalizeText(
      state?.studyAuthorizationSignature
    );

    if (!suppliedSignature) {
      return false;
    }

    const expectedSignature =
      createCommunityStudyOAuthStateSignature({
        requestId: state?.requestId,
        organizerEmail: state?.organizerEmail,
        oauthEnvironment: state?.oauthEnvironment,
        invitationToken: state?.invitationToken,
        studyRecheck: state?.studyRecheck,
        studyContext: state?.studyContext,
        secret,
      });

    return secureStringEquals(
      suppliedSignature,
      expectedSignature
    );
  } catch {
    return false;
  }
}

export function verifyBasicDurationAuthorizationToken(
  token,
  {
    requestId,
    organizerEmail,
    oauthEnvironment,
    secret,
    now = Date.now(),
  }
) {
  try {
    const [encodedPayload, suppliedSignature, extraPart] =
      normalizeText(token).split(".");

    if (!encodedPayload || !suppliedSignature || extraPart) {
      return null;
    }

    const normalizedSecret = normalizeText(secret);

    if (!normalizedSecret) {
      return null;
    }

    const expectedSignature = crypto
      .createHmac("sha256", normalizedSecret)
      .update(encodedPayload)
      .digest("base64url");

    if (!secureStringEquals(suppliedSignature, expectedSignature)) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    );
    const normalizedOAuthEnvironment =
      normalizeOAuthEnvironment(oauthEnvironment);

    if (
      !Number.isFinite(now) ||
      payload?.purpose !== "zoom-basic-duration" ||
      payload.requestId !== normalizeText(requestId) ||
      (organizerEmail !== undefined &&
        payload.organizerEmail !== normalizeEmail(organizerEmail)) ||
      (oauthEnvironment !== undefined &&
        payload.oauthEnvironment !== normalizedOAuthEnvironment) ||
      !normalizeText(payload.zoomUserId) ||
      !Number.isFinite(payload.issuedAt) ||
      !Number.isFinite(payload.expiresAt) ||
      payload.issuedAt > now + 60_000 ||
      payload.expiresAt <= now ||
      payload.expiresAt <= payload.issuedAt ||
      payload.expiresAt - payload.issuedAt >
        BASIC_DURATION_AUTHORIZATION_TTL_MS
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
