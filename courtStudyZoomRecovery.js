import { normalizeZoomIdentityEmail } from "./courtStudyDuration.js";

function createVerificationError(code, message, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeMeetingId(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "");
}

function parseExplicitTimestamp(value) {
  const timestamp = String(value || "").trim();
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp)) {
    return null;
  }

  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function verifiedZoomUrl(value, fieldName) {
  if (!value) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw createVerificationError(
      "ZOOM_MEETING_URL_INVALID",
      `Zoom did not return a valid ${fieldName}. Do not save administrator-supplied meeting links.`
    );
  }

  if (
    parsed.protocol !== "https:" ||
    (parsed.hostname !== "zoom.us" &&
      !parsed.hostname.toLowerCase().endsWith(".zoom.us"))
  ) {
    throw createVerificationError(
      "ZOOM_MEETING_URL_INVALID",
      `The verified Zoom response did not contain a trusted ${fieldName}. Reconcile the meeting through Zoom before saving it.`
    );
  }

  return parsed.toString();
}

export function verifyExistingZoomMeeting({
  suppliedMeetingId,
  expectedHostId,
  authorizedHostEmail,
  expectedOrganizerEmail,
  meetingFormat,
  scheduledStart,
  scheduledEnd,
  zoomMeeting,
}) {
  const normalizedSuppliedId =
    normalizeMeetingId(suppliedMeetingId);
  const verifiedMeetingId =
    normalizeMeetingId(zoomMeeting?.id);

  if (
    !normalizedSuppliedId ||
    !verifiedMeetingId ||
    normalizedSuppliedId !== verifiedMeetingId
  ) {
    throw createVerificationError(
      "ZOOM_MEETING_ID_MISMATCH",
      "The Zoom meeting returned by the read operation does not match the supplied meeting ID. No details were saved."
    );
  }

  if (
    !expectedHostId ||
    String(zoomMeeting?.host_id || "").trim() !==
      String(expectedHostId).trim()
  ) {
    throw createVerificationError(
      "ZOOM_MEETING_HOST_MISMATCH",
      "The existing Zoom meeting is not hosted by the authorized hosting account. No details were saved."
    );
  }

  if (
    String(meetingFormat || "").trim().toUpperCase() ===
    "COMMUNITY_HOSTED"
  ) {
    if (
      !normalizeZoomIdentityEmail(expectedOrganizerEmail) ||
      normalizeZoomIdentityEmail(authorizedHostEmail) !==
        normalizeZoomIdentityEmail(expectedOrganizerEmail)
    ) {
      throw createVerificationError(
        "ZOOM_MEETING_ORGANIZER_MISMATCH",
        "The authenticated Zoom account does not match the authorized study organizer. No details were saved."
      );
    }
  }

  if (Number(zoomMeeting?.type) !== 2) {
    throw createVerificationError(
      "ZOOM_MEETING_TYPE_UNSUPPORTED",
      "The Zoom meeting is not a standard scheduled meeting. No details were saved."
    );
  }

  const expectedStart = new Date(scheduledStart);
  const expectedEnd = new Date(scheduledEnd);
  const actualStart = parseExplicitTimestamp(
    zoomMeeting?.start_time
  );
  const expectedDurationMs =
    expectedEnd.getTime() - expectedStart.getTime();
  const expectedDurationMinutes =
    expectedDurationMs / 60_000;

  if (
    Number.isNaN(expectedStart.getTime()) ||
    Number.isNaN(expectedEnd.getTime()) ||
    !Number.isInteger(expectedDurationMinutes) ||
    expectedDurationMinutes <= 0 ||
    !actualStart ||
    actualStart.getTime() !== expectedStart.getTime()
  ) {
    throw createVerificationError(
      "ZOOM_MEETING_START_MISMATCH",
      "The verified Zoom meeting start does not exactly match the scheduled study time. No details were saved."
    );
  }

  if (
    Number(zoomMeeting?.duration) !==
    expectedDurationMinutes
  ) {
    throw createVerificationError(
      "ZOOM_MEETING_DURATION_MISMATCH",
      "The verified Zoom meeting duration does not match the scheduled study duration. No details were saved."
    );
  }

  const zoomJoinUrl = verifiedZoomUrl(
    zoomMeeting?.join_url,
    "join link"
  );
  const zoomRegistrationUrl = verifiedZoomUrl(
    zoomMeeting?.registration_url,
    "registration link"
  );

  if (!zoomJoinUrl && !zoomRegistrationUrl) {
    throw createVerificationError(
      "ZOOM_MEETING_LINK_MISSING",
      "Zoom did not return a join or registration link for the verified meeting. No details were saved."
    );
  }

  return {
    zoomMeetingId: verifiedMeetingId,
    zoomJoinUrl,
    zoomRegistrationUrl,
  };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function fetchVerifiedZoomMeeting({
  accessToken,
  suppliedMeetingId,
  expectedOrganizerEmail,
  meetingFormat,
  scheduledStart,
  scheduledEnd,
  fetchImpl,
}) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
  };

  let profileResponse;
  try {
    profileResponse = await fetchImpl(
      "https://api.zoom.us/v2/users/me",
      { method: "GET", headers }
    );
  } catch {
    throw createVerificationError(
      "ZOOM_ACCOUNT_READ_FAILED",
      "Could not verify the authorized Zoom hosting account. Restore its Zoom connection and retry reconciliation.",
      502
    );
  }

  const zoomUser = await readJson(profileResponse);
  if (!profileResponse.ok || !zoomUser?.id) {
    throw createVerificationError(
      "ZOOM_ACCOUNT_READ_FAILED",
      "Could not verify the authorized Zoom hosting account with its existing read access. Check the connection and retry reconciliation.",
      502
    );
  }

  let meetingResponse;
  try {
    meetingResponse = await fetchImpl(
      `https://api.zoom.us/v2/meetings/${encodeURIComponent(
        normalizeMeetingId(suppliedMeetingId)
      )}`,
      { method: "GET", headers }
    );
  } catch {
    throw createVerificationError(
      "ZOOM_MEETING_READ_FAILED",
      "Zoom could not be reached to independently verify the existing meeting. No details were saved; retry only after Zoom verification is available.",
      502
    );
  }

  const zoomMeeting = await readJson(meetingResponse);
  if (!meetingResponse.ok || !zoomMeeting) {
    const scopeGuidance =
      meetingResponse.status === 401 ||
      meetingResponse.status === 403
        ? " The existing Zoom authorization may not include meeting:read:meeting; do not broaden scopes without separate approval."
        : "";
    throw createVerificationError(
      "ZOOM_MEETING_READ_FAILED",
      `Zoom could not independently read the supplied meeting. Confirm the meeting ID, ownership, and existing Zoom read authorization.${scopeGuidance} No details were saved.`,
      502
    );
  }

  return verifyExistingZoomMeeting({
    suppliedMeetingId,
    expectedHostId: zoomUser.id,
    authorizedHostEmail: zoomUser.email,
    expectedOrganizerEmail:
      expectedOrganizerEmail,
    meetingFormat,
    scheduledStart,
    scheduledEnd,
    zoomMeeting,
  });
}

export function isCourtStudyDiagnosticZoomMeetingEnabled(
  value
) {
  return String(value ?? "")
    .trim()
    .toLowerCase() === "true";
}
