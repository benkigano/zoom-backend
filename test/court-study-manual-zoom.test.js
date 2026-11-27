import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchVerifiedZoomMeeting,
  isCourtStudyDiagnosticZoomMeetingEnabled,
  verifyExistingZoomMeeting,
} from "../courtStudyZoomRecovery.js";

const expectedMeeting = {
  id: "987654321",
  host_id: "zoom-host-1",
  type: 2,
  start_time: "2026-11-27T18:00:00Z",
  duration: 60,
  join_url: "https://us02web.zoom.us/j/987654321",
  registration_url: "https://zoom.us/meeting/register/example",
};

const expectedSchedule = {
  scheduledStart: new Date("2026-11-27T18:00:00.000Z"),
  scheduledEnd: new Date("2026-11-27T19:00:00.000Z"),
};

function jsonResponse(body, { status = 200, ok = true } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

function createFetchStub({
  profile = {
    id: "zoom-host-1",
    email: "organizer@example.org",
  },
  meeting = expectedMeeting,
  meetingResponse = null,
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/users/me")) {
      return jsonResponse(profile);
    }
    if (String(url).endsWith("/meetings/987654321")) {
      return meetingResponse || jsonResponse(meeting);
    }
    assert.fail(`Unexpected Zoom read endpoint: ${url}`);
  };

  return { calls, fetchImpl };
}

test("manual reconciliation reads and saves only verified Zoom meeting details", async () => {
  const { calls, fetchImpl } = createFetchStub();

  const verified = await fetchVerifiedZoomMeeting({
    accessToken: "mock-access-token",
    suppliedMeetingId: "987 654 321",
    expectedOrganizerEmail: "organizer@example.org",
    meetingFormat: "COMMUNITY_HOSTED",
    ...expectedSchedule,
    fetchImpl,
  });

  assert.deepEqual(
    calls.map(({ options }) => options.method),
    ["GET", "GET"]
  );
  assert.equal(verified.zoomMeetingId, "987654321");
  assert.equal(
    verified.zoomJoinUrl,
    expectedMeeting.join_url
  );
  assert.equal(
    verified.zoomRegistrationUrl,
    expectedMeeting.registration_url
  );
});

test("manual reconciliation rejects mismatched meeting identity, host, timing, duration, and type", () => {
  const verify = (overrides = {}) =>
    verifyExistingZoomMeeting({
      suppliedMeetingId: expectedMeeting.id,
      expectedHostId: "zoom-host-1",
      authorizedHostEmail: "organizer@example.org",
      expectedOrganizerEmail: "organizer@example.org",
      meetingFormat: "COMMUNITY_HOSTED",
      ...expectedSchedule,
      zoomMeeting: expectedMeeting,
      ...overrides,
    });

  assert.throws(
    () => verify({ zoomMeeting: { ...expectedMeeting, id: "other-id" } }),
    { code: "ZOOM_MEETING_ID_MISMATCH" }
  );
  assert.throws(
    () =>
      verify({
        zoomMeeting: {
          ...expectedMeeting,
          host_id: "unexpected-host",
        },
      }),
    { code: "ZOOM_MEETING_HOST_MISMATCH" }
  );
  assert.throws(
    () =>
      verify({
        zoomMeeting: {
          ...expectedMeeting,
          duration: 45,
        },
      }),
    { code: "ZOOM_MEETING_DURATION_MISMATCH" }
  );
  assert.throws(
    () =>
      verify({
        zoomMeeting: {
          ...expectedMeeting,
          start_time: "2026-11-27T18:01:00Z",
        },
      }),
    { code: "ZOOM_MEETING_START_MISMATCH" }
  );
  assert.throws(
    () =>
      verify({
        zoomMeeting: {
          ...expectedMeeting,
          type: 3,
        },
      }),
    { code: "ZOOM_MEETING_TYPE_UNSUPPORTED" }
  );
  assert.throws(
    () =>
      verify({
        authorizedHostEmail: "different@example.org",
      }),
    { code: "ZOOM_MEETING_ORGANIZER_MISMATCH" }
  );
});

test("meeting read failure fails closed without issuing any create request", async () => {
  const { calls, fetchImpl } = createFetchStub({
    meetingResponse: jsonResponse(
      { message: "scope denied" },
      { status: 403, ok: false }
    ),
  });

  await assert.rejects(
    fetchVerifiedZoomMeeting({
      accessToken: "mock-access-token",
      suppliedMeetingId: expectedMeeting.id,
      expectedOrganizerEmail: "organizer@example.org",
      meetingFormat: "COMMUNITY_HOSTED",
      ...expectedSchedule,
      fetchImpl,
    }),
    {
      code: "ZOOM_MEETING_READ_FAILED",
      message: /meeting:read:meeting/,
    }
  );

  assert.deepEqual(
    calls.map(({ options }) => options.method),
    ["GET", "GET"]
  );
});

test("diagnostic meeting creation is disabled unless explicitly enabled", () => {
  assert.equal(
    isCourtStudyDiagnosticZoomMeetingEnabled(undefined),
    false
  );
  assert.equal(
    isCourtStudyDiagnosticZoomMeetingEnabled("false"),
    false
  );
  assert.equal(
    isCourtStudyDiagnosticZoomMeetingEnabled("true"),
    true
  );
});
