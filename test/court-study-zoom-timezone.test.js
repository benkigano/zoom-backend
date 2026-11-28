import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import {
  classifyZoomAccountType,
  normalizeZoomIdentityEmail,
  resolveCommunityHostedStudyDuration,
  resolveCommunityHostedZoomDurationDecision,
} from "../courtStudyDuration.js";
import {
  createCommunityStudyZoomSchedule,
  createCourtStudySchedulingDiagnostic,
  createUtcScheduleWindow,
  formatCourtStudySetupFailure,
  getScheduledDurationMinutes,
  resolveCourtStudyScheduleDuration,
  resolveCourtStudyInvitationToken,
  resolveZoomCreationDisposition,
  runCourtStudySetupStages,
  runZoomCreationWithClaim,
  verifyZoomCreatedSchedule,
} from "../courtStudyScheduling.js";

const source = readFileSync(new URL("../server.js", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");
const start = source.indexOf("async function createCourtStudyZoomInternal(");
const end = source.indexOf(
  "\n\n// ==========================================================\n// Admin route: manually create the Zoom meeting",
  start
);
assert.ok(start >= 0 && end > start, "Could not isolate the shared creation function");
const creationSource = source.slice(start, end).trim();
const loggerStart = source.indexOf("function logCourtStudySchedulingDiagnostic(");
const loggerEnd = source.indexOf("\n\napp.disable(", loggerStart);
assert.ok(loggerStart >= 0 && loggerEnd > loggerStart, "Could not isolate the diagnostic logger");
const loggerSource = source.slice(loggerStart, loggerEnd).trim();

function createTestLogger(failure, diagnostics, warnings) {
  const testConsole = {
    error: (...args) => {
      if (args[0] === "Community study scheduling diagnostic") {
        if (failure === "sync" || failure === "warning" || failure === "warningAsync") {
          throw new Error("private diagnostic failure");
        }
        if (failure === "async") return Promise.reject(new Error("private diagnostic failure"));
        diagnostics.push(args[1]);
        return;
      }
      diagnostics.push(args);
    },
  };
  const log = runInNewContext(`(${loggerSource})`, {
    console: testConsole,
    createCourtStudySchedulingDiagnostic: failure === "formatter"
      ? () => { throw new Error("private diagnostic formatter failure"); }
      : createCourtStudySchedulingDiagnostic,
    process: {
      emitWarning: (message) => {
        if (failure === "warning") throw new Error("private warning failure");
        if (failure === "warningAsync") {
          return Promise.reject(new Error("private warning failure"));
        }
        warnings.push(message);
      },
    },
  });
  return { log, console: testConsole };
}

function harness({
  studyFocusType = "BOOK_STUDY",
  accountType = 1,
  duration = 40,
  returned = { start_time: "2026-12-05T03:00:00Z", duration: 40 },
  transportFailure = false,
  invalidJson = false,
  persistenceFailure = false,
  httpStatus = 201,
  diagnosticFailure = null,
  meetingFormat = "COMMUNITY_HOSTED",
} = {}) {
  const meeting = {
    id: "local-meeting",
    courtStudyRequestId: "test-request",
    status: "SCHEDULED",
    scheduledStart: new Date("2026-12-05T03:00:00Z"),
    scheduledEnd: new Date(Date.parse("2026-12-05T03:00:00Z") + duration * 60000),
    timezone: "America/Los_Angeles",
    zoomMeetingId: null,
    zoomJoinUrl: null,
    zoomRegistrationUrl: null,
    title: "Test study",
  };
  const request = {
    id: "test-request",
    status: "SCHEDULED",
    meetingFormat,
    studyFocusType,
    durationMinutes: duration,
    organizerEmail: "private@example.test",
    courtStudyMeeting: meeting,
  };
  const diagnostics = [];
  const warnings = [];
  const payloads = [];
  let invitationCalls = 0;
  const logger = createTestLogger(diagnosticFailure, diagnostics, warnings);
  const prisma = {
    courtStudyRequest: {
      findUnique: async () => request,
    },
    courtStudyMeeting: {
      findUnique: async () => meeting,
      updateMany: async ({ where, data }) => {
        if (where.status !== meeting.status || meeting.zoomMeetingId !== null) {
          return { count: 0 };
        }
        if (data.zoomMeetingId && persistenceFailure) {
          throw new Error("private database exception");
        }
        Object.assign(meeting, data);
        return { count: 1 };
      },
    },
  };
  const createZoom = runInNewContext(`(${creationSource})`, {
    Date,
    Intl,
    prisma,
    getScheduledDurationMinutes,
    resolveCommunityHostedStudyDuration,
    resolveZoomCreationDisposition,
    createCommunityStudyZoomSchedule,
    runZoomCreationWithClaim,
    verifyZoomCreatedSchedule,
    normalizeZoomIdentityEmail,
    classifyZoomAccountType,
    getCourtStudyHostZoomAccessToken: async () => "private-access-token",
    getS2SAccessToken: async () => assert.fail("Unexpected S2S request"),
    logCourtStudySchedulingDiagnostic: logger.log,
    console: logger.console,
    fetch: async (url, options) => {
      if (url.endsWith("/users/me")) {
        return {
          ok: true,
          json: async () => ({
            id: "host",
            email: "private@example.test",
            type: accountType,
          }),
        };
      }
      assert.equal(url, "https://api.zoom.us/v2/users/me/meetings");
      payloads.push(JSON.parse(options.body));
      if (transportFailure) throw new Error("private transport exception");
      return {
        ok: httpStatus >= 200 && httpStatus < 300,
        status: httpStatus,
        json: async () => {
          if (invalidJson) throw new Error("private response");
          return { id: "zoom-123", join_url: "https://zoom.us/private-link", ...returned };
        },
      };
    },
  });

  return {
    meeting,
    diagnostics,
    warnings,
    payloads,
    createZoom: () => createZoom({ requestId: request.id }),
    setup: () => runCourtStudySetupStages({
      schedule: async () => ({ success: true, meeting }),
      createZoom: () => createZoom({ requestId: request.id }),
      sendInvitation: async () => {
        invitationCalls += 1;
        return { success: true, responseBody: { success: true } };
      },
    }),
    get invitationCalls() { return invitationCalls; },
  };
}

test("shared creation sends organizer-local payload for Basic Book Study and paid Court Study", async () => {
  for (const [studyFocusType, accountType, duration] of [
    ["BOOK_STUDY", 1, 40],
    ["RULES_OF_PROCEDURE", 2, 60],
  ]) {
    const request = {
      meetingFormat: "COMMUNITY_HOSTED",
      studyFocusType,
      durationMinutes: 60,
    };
    const decision = resolveCommunityHostedZoomDurationDecision(
      request, classifyZoomAccountType(accountType)
    );
    const scheduledDuration = decision.requiresBasicDurationChoice
      ? resolveCourtStudyScheduleDuration(request, 40)
      : decision.scheduledDurationMinutes;
    assert.equal(scheduledDuration, duration);
    const window = createUtcScheduleWindow("2026-12-05T03:00:00Z", scheduledDuration);
    const h = harness({
      studyFocusType, accountType, duration,
      returned: { start_time: "2026-12-05T03:00:00Z", duration },
    });
    const result = await h.setup();
    assert.equal(result.success, true);
    assert.equal(h.payloads.length, 1);
    assert.equal(h.payloads[0].start_time, "2026-12-04T19:00:00");
    assert.equal(h.payloads[0].timezone, "America/Los_Angeles");
    assert.equal(h.payloads[0].duration, duration);
    assert.equal(h.meeting.scheduledStart.toISOString(), window.scheduledStart);
    assert.equal(h.meeting.scheduledEnd.toISOString(), window.scheduledEnd);
    assert.equal(h.meeting.timezone, "America/Los_Angeles");
    assert.equal(h.invitationCalls, 1);
  }
});

test("local payload preserves instants in supported zones and across daylight-saving transitions", () => {
  const cases = [
    ["2026-12-06T03:00:00Z", "America/Los_Angeles", "2026-12-05T19:00:00"],
    ["2026-12-07T03:00:00Z", "America/Los_Angeles", "2026-12-06T19:00:00"],
    ["2026-07-01T02:00:00Z", "America/Los_Angeles", "2026-06-30T19:00:00"],
    ["2026-03-08T09:30:00Z", "America/Los_Angeles", "2026-03-08T01:30:00"],
    ["2026-03-08T10:30:00Z", "America/Los_Angeles", "2026-03-08T03:30:00"],
    ["2026-11-01T07:30:00Z", "America/Los_Angeles", "2026-11-01T00:30:00"],
    ["2026-11-01T10:30:00Z", "America/Los_Angeles", "2026-11-01T02:30:00"],
    ["2026-12-06T03:00:00Z", "America/Denver", "2026-12-05T20:00:00"],
    ["2026-12-06T03:00:00Z", "America/Chicago", "2026-12-05T21:00:00"],
    ["2026-12-06T03:00:00Z", "America/New_York", "2026-12-05T22:00:00"],
    ["2026-12-06T03:00:00Z", "America/Anchorage", "2026-12-05T18:00:00"],
    ["2026-12-06T03:00:00Z", "Pacific/Honolulu", "2026-12-05T17:00:00"],
    ["2026-12-06T03:00:00Z", "Asia/Kathmandu", "2026-12-06T08:45:00"],
    ["2026-12-06T03:00:00Z", "UTC", "2026-12-06T03:00:00"],
  ];
  for (const [instant, timezone, expectedLocal] of cases) {
    const schedule = createCommunityStudyZoomSchedule(new Date(instant), 40, timezone);
    assert.equal(schedule.start_time, expectedLocal);
    assert.equal(schedule.timezone, timezone);
  }
});

test("unsupported outbound precision fails before claim or Zoom dispatch", async () => {
  assert.throws(
    () => createCommunityStudyZoomSchedule(new Date("2026-12-05T03:00:00.001Z"), 40, "UTC"),
    /whole-second/
  );
  assert.throws(() => createCommunityStudyZoomSchedule(null, 40, "UTC"), /whole-second/);
  const h = harness();
  h.meeting.scheduledStart = new Date("2026-12-05T03:00:00.001Z");
  h.meeting.scheduledEnd = new Date("2026-12-05T03:40:00.001Z");
  const result = await h.createZoom();
  assert.equal(result.statusCode, 409);
  assert.equal(h.meeting.status, "SCHEDULED");
  assert.equal(h.payloads.length, 0);
  assert.equal(h.diagnostics[0].classification, "INVALID_OUTBOUND_SCHEDULE");
});

test("ambiguous fall-back times and invalid zones fail before Zoom dispatch", async () => {
  for (const instant of ["2026-11-01T08:30:00Z", "2026-11-01T09:30:00Z"]) {
    const h = harness();
    h.meeting.scheduledStart = new Date(instant);
    h.meeting.scheduledEnd = new Date(Date.parse(instant) + 40 * 60000);
    const result = await h.createZoom();
    assert.equal(result.statusCode, 409);
    assert.match(result.responseBody.error, /ambiguous local time/);
    assert.equal(h.meeting.status, "SCHEDULED");
    assert.equal(h.payloads.length, 0);
  }
  const h = harness();
  h.meeting.timezone = "Invalid/Zone";
  assert.equal((await h.createZoom()).statusCode, 409);
  assert.equal(h.meeting.status, "SCHEDULED");
  assert.equal(h.payloads.length, 0);
});

test("equivalent explicit offsets are verified as the same instant", async () => {
  const h = harness({
    returned: { start_time: "2026-12-04T19:00:00-08:00", duration: 40 },
  });
  assert.equal((await h.setup()).success, true);
  assert.equal(h.meeting.zoomMeetingId, "zoom-123");
});

test("mismatched and unverifiable returned schedules preserve claims and block invitations and retries", async () => {
  const cases = [
    [{ start_time: "2026-12-05T11:00:00Z", duration: 40 }, "ZOOM_START_MISMATCH"],
    [{ duration: 40 }, "ZOOM_START_MISSING"],
    [{ start_time: "2026-12-05T03:00:00", duration: 40 }, "ZOOM_START_INVALID"],
    [{ start_time: "2026-02-30T03:00:00Z", duration: 40 }, "ZOOM_START_INVALID"],
    [{ start_time: "not-a-timestamp", duration: 40 }, "ZOOM_START_INVALID"],
    [{ start_time: "2026-12-05T03:00:00.0001Z", duration: 40 }, "ZOOM_START_INVALID"],
    [{ start_time: "2026-12-05T03:00:00Z" }, "ZOOM_DURATION_MISSING"],
    [{ start_time: "2026-12-05T03:00:00Z", duration: true }, "ZOOM_DURATION_INVALID"],
    [{ start_time: "2026-12-05T03:00:00Z", duration: 60 }, "ZOOM_DURATION_MISMATCH"],
  ];
  for (const [returned, classification] of cases) {
    const h = harness({ returned });
    const result = await h.setup();
    assert.equal(result.failureType, "ZOOM_OUTCOME_UNCERTAIN", classification);
    assert.equal(h.diagnostics[0].classification, classification);
    assert.equal(h.meeting.status, "CREATING");
    assert.equal(h.meeting.zoomMeetingId, null);
    assert.equal(h.invitationCalls, 0);
    assert.equal((await h.createZoom()).responseBody.reconciliationRequired, true);
    assert.equal(h.payloads.length, 1);
  }
});

test("transport, incomplete response, and persistence failures have distinct safe diagnostics", async () => {
  for (const [options, classification] of [
    [{ transportFailure: true }, "ZOOM_TRANSPORT_FAILURE"],
    [{ invalidJson: true }, "ZOOM_RESPONSE_INVALID_JSON"],
    [{ returned: { id: null } }, "ZOOM_RESPONSE_INCOMPLETE"],
    [{ persistenceFailure: true }, "DATABASE_PERSISTENCE_FAILURE"],
  ]) {
    const h = harness(options);
    assert.equal((await h.setup()).failureType, "ZOOM_OUTCOME_UNCERTAIN");
    assert.equal(h.meeting.status, "CREATING");
    assert.equal(h.invitationCalls, 0);
    assert.ok(h.diagnostics.some((entry) => entry.classification === classification));
    assert.doesNotMatch(JSON.stringify(h.diagnostics), /private|zoom-123|example\.test/i);
  }
});

test("Zoom HTTP failures distinguish definitive rejection from uncertain outcomes", async () => {
  for (const [status, classification, state, failureType] of [
    [400, "ZOOM_REQUEST_REJECTED", "FAILED", "ZOOM_NOT_CREATED"],
    [503, "ZOOM_REQUEST_UNCERTAIN", "CREATING", "ZOOM_OUTCOME_UNCERTAIN"],
  ]) {
    const h = harness({ httpStatus: status });
    const result = await h.setup();
    assert.equal(result.failureType, failureType);
    assert.equal(h.meeting.status, state);
    assert.equal(h.invitationCalls, 0);
    assert.equal(h.diagnostics[0].classification, classification);
    assert.equal(h.diagnostics[0].httpStatus, status);
  }
});

test("diagnostic failures preserve creation outcomes and claim dispositions", async () => {
  for (const options of [
    { httpStatus: 400 },
    { httpStatus: 503 },
    { transportFailure: true },
    { returned: { start_time: "2026-12-05T11:00:00Z", duration: 40 } },
    { persistenceFailure: true },
    { invalidPrecision: true },
  ]) {
    let expected;
    for (const diagnosticFailure of [null, "sync", "async", "formatter", "warning", "warningAsync"]) {
      const h = harness({ ...options, diagnosticFailure });
      if (options.invalidPrecision) {
        h.meeting.scheduledStart = new Date("2026-12-05T03:00:00.001Z");
        h.meeting.scheduledEnd = new Date("2026-12-05T03:40:00.001Z");
      }
      const result = await h.setup();
      await new Promise((resolve) => setImmediate(resolve));
      const observed = {
        result: JSON.parse(JSON.stringify(result)),
        status: h.meeting.status,
        savedZoomId: h.meeting.zoomMeetingId,
        requests: h.payloads.length,
        invitations: h.invitationCalls,
      };
      if (!diagnosticFailure) {
        expected = observed;
      } else {
        assert.deepEqual(observed, expected, `${diagnosticFailure}: ${JSON.stringify(options)}`);
        if (diagnosticFailure !== "warning" && diagnosticFailure !== "warningAsync") {
          assert.ok(h.warnings.length > 0);
          assert.ok(h.warnings.every(
            (message) => message === "Community study scheduling diagnostic unavailable."
          ));
        }
      }
    }
  }
});

test("invitation diagnostic failures preserve both continuation and OAuth responses", async () => {
  const callbackStart = source.indexOf(
    "  if (!setupResult.success) {",
    source.indexOf("const automaticDurationMinutes")
  );
  const callbackEnd = source.indexOf("\n\n  connectedStudySetupCompleted = true;", callbackStart);
  const continuationStart = source.indexOf(
    "\nif (!setupResult.success) {",
    source.indexOf('"/api/book-study/use-basic-duration"')
  );
  const continuationEnd = source.indexOf(
    "\n\ncontinuationStage = \"setup_complete\";",
    continuationStart
  );
  assert.ok(callbackStart >= 0 && callbackEnd > callbackStart);
  assert.ok(continuationStart >= 0 && continuationEnd > continuationStart);

  for (const block of [
    source.slice(callbackStart, callbackEnd),
    source.slice(continuationStart, continuationEnd),
  ]) {
    for (const failureType of ["INVITATION_NOT_SENT", "INVITATION_OUTCOME_UNCERTAIN"]) {
      let expected;
      for (const diagnosticFailure of [null, "sync", "async", "formatter", "warning", "warningAsync"]) {
        const diagnostics = [];
        const warnings = [];
        const logger = createTestLogger(diagnosticFailure, diagnostics, warnings);
        const response = {
          statusCode: null,
          contentType: null,
          body: null,
          status(value) { this.statusCode = value; return this; },
          type(value) { this.contentType = value; return this; },
          send(value) { this.body = value; return this; },
        };
        const execute = runInNewContext(`(async () => { ${block} })`, {
          setupResult: { success: false, failedStage: "INVITATION", failureType },
          requestId: "test-request",
          scheduleWindow: { scheduledStart: "2026-12-05T03:00:00Z" },
          automaticDurationMinutes: 60,
          studyName: "Court Study",
          studyDisplayName: "Book Study",
          callbackStage: "invitation_delivery",
          continuationStage: "invitation_delivery",
          logCourtStudySchedulingDiagnostic: logger.log,
          console: logger.console,
          formatCourtStudySetupFailure,
          res: response,
        });
        await execute();
        await new Promise((resolve) => setImmediate(resolve));
        const observed = {
          statusCode: response.statusCode,
          contentType: response.contentType,
          body: response.body,
        };
        if (!diagnosticFailure) {
          expected = observed;
        } else {
          assert.deepEqual(observed, expected);
          if (diagnosticFailure !== "warning" && diagnosticFailure !== "warningAsync") {
            assert.ok(warnings.length > 0);
          }
        }
        assert.equal(response.statusCode, 502);
        assert.match(response.body, failureType === "INVITATION_NOT_SENT"
          ? /invitation was not sent/
          : /invitation delivery is uncertain/);
      }
    }
  }
});

test("invalid non-community meeting duration retains baseline HTTP 500 behavior", async () => {
  const h = harness({ meetingFormat: "COURT_HOSTED" });
  h.meeting.scheduledEnd = new Date("2026-12-05T03:00:30Z");
  const result = await h.createZoom();
  assert.equal(result.statusCode, 500);
  assert.equal(result.responseBody.success, false);
  assert.equal(result.responseBody.noMeetingCreated, true);
  assert.equal(
    result.responseBody.error,
    "Scheduled start and end must define a positive whole-minute duration."
  );
  assert.equal(h.meeting.status, "SCHEDULED");
  assert.equal(h.payloads.length, 0);
});

test("automatic and admin paths generate both study invitations without Zoom registration", async () => {
  const invitationStart = source.indexOf("async function sendCourtStudyInvitationInternal(");
  const invitationEnd = source.indexOf(
    "\n\n// =====================================================\n// Admin route: manually send/resend Court Study invitation",
    invitationStart
  );
  const adminStart = source.indexOf('app.post(\n  "/api/court-study-requests/:id/send-invitation"', invitationEnd);
  const adminEnd = source.indexOf("\n\n// =====================================================", adminStart);
  assert.ok(invitationStart >= 0 && invitationEnd > invitationStart);
  assert.ok(adminStart > invitationEnd && adminEnd > adminStart);

  const automaticStart = source.indexOf(
    "  const setupResult =\n    await runCourtStudySetupStages({",
    source.indexOf("const automaticDurationMinutes")
  );
  const automaticEnd = source.indexOf("\n    });", automaticStart) + "\n    });".length;
  const continuationStart = source.indexOf(
    "const setupResult =\n  await runCourtStudySetupStages({",
    source.indexOf('"/api/book-study/use-basic-duration"')
  );
  const continuationEnd = source.indexOf("\n  });", continuationStart) + "\n  });".length;
  assert.ok(automaticStart >= 0 && automaticEnd > automaticStart);
  assert.ok(continuationStart >= 0 && continuationEnd > continuationStart);

  for (const studyFocusType of ["BOOK_STUDY", "RULES_OF_PROCEDURE"]) {
    for (const path of ["automatic", "continuation", "admin"]) {
      const meeting = {
        id: "local-meeting",
        status: "SCHEDULED",
        zoomMeetingId: "mock-zoom",
        zoomJoinUrl: "https://example.test/join",
        zoomRegistrationUrl: null,
        publicInvitationToken: "mock-token",
        scheduledStart: new Date("2026-12-06T03:00:00Z"),
        scheduledEnd: new Date("2026-12-06T03:40:00Z"),
        timezone: "America/Los_Angeles",
        title: "Test study",
        invitationSendCount: 0,
      };
      const request = {
        id: "test-request",
        status: "SCHEDULED",
        meetingFormat: "COMMUNITY_HOSTED",
        studyFocusType,
        organizerName: "Test Organizer",
        organizerEmail: "organizer@example.test",
        hostGroupName: "Test Group",
        selectedRulesSections: [],
        bookExcerptHtml: "Test excerpt",
        courtStudyMeeting: meeting,
      };
      const sent = [];
      const tx = {
        courtStudyRequest: {
          updateMany: async ({ data }) => {
            Object.assign(request, data);
            return { count: 1 };
          },
        },
        courtStudyMeeting: {
          updateMany: async ({ data }) => {
            meeting.invitationSendCount += data.invitationSendCount.increment;
            meeting.invitationSentAt = data.invitationSentAt;
            return { count: 1 };
          },
          findUnique: async () => meeting,
        },
      };
      const prisma = {
        courtStudyRequest: { findUnique: async () => request },
        $transaction: async (operation) => operation(tx),
      };
      const sendInvitation = runInNewContext(
        `(${source.slice(invitationStart, invitationEnd).trim()})`,
        {
          prisma,
          getScheduledDurationMinutes,
          resolveCourtStudyInvitationToken,
          convert: (text) => text,
          safeEmailHtml: (text) => text,
          safeEmailWebUrl: (text) => text,
          sendEmail: async (...args) => { sent.push(args); },
          console,
        }
      );
      if (path === "admin") {
        let handler;
        runInNewContext(source.slice(adminStart, adminEnd), {
          app: { post: (_route, _auth, wrapped) => { handler = wrapped; } },
          requireAdminToken: () => {},
          withCourtStudyWorkflowGate: (wrapped) => wrapped,
          sendCourtStudyInvitationInternal: sendInvitation,
          console,
        });
        const response = {
          status(code) { this.statusCode = code; return this; },
          json(body) { this.body = body; return this; },
        };
        await handler({ params: { id: request.id } }, response);
        assert.equal(response.statusCode, 200);
        assert.equal(response.body.success, true);
      } else {
        const block = path === "automatic"
          ? source.slice(automaticStart, automaticEnd)
          : source.slice(continuationStart, continuationEnd);
        const execute = runInNewContext(`(async () => { ${block}\nreturn setupResult; })`, {
          runCourtStudySetupStages,
          scheduleCourtStudyInternal: async () => ({ success: true, meeting }),
          createCourtStudyZoomInternal: async () => ({
            success: true, responseBody: { success: true },
          }),
          sendCourtStudyInvitationInternal: sendInvitation,
          requestId: request.id,
          scheduleWindow: {},
          requestTimeZone: meeting.timezone,
          callbackStage: "",
          continuationStage: "",
        });
        assert.equal((await execute()).success, true);
      }
      assert.equal(sent.length, 1, `${studyFocusType} ${path}`);
      assert.match(sent[0][1], studyFocusType === "BOOK_STUDY" ? /Book Study Session Ready/ : /Court Study Session Ready/);
      assert.match(sent[0][2], /December 5, 2026 at 7:00 PM Pacific Time \(40 minutes\)/);
      assert.match(sent[0][2], /https:\/\/example\.test\/join/);
      assert.equal(request.status, "SESSION_READY");
      assert.equal(meeting.invitationSendCount, 1);
    }
  }
});

test("diagnostics include only allowlisted safe fields and normalized timestamps", () => {
  const diagnostic = createCourtStudySchedulingDiagnostic({
    requestId: "test-request",
    stage: "zoom_creation",
    classification: "ZOOM_START_MISMATCH",
    expectedStart: "2026-12-05T03:00:00Z",
    expectedDuration: 40,
    returnedStart: "2026-12-05T03:00:00-08:00",
    returnedDuration: 40,
    token: "secret",
    email: "private@example.test",
    error: new Error("private exception"),
  });
  assert.deepEqual(diagnostic, {
    requestId: "test-request",
    stage: "zoom_creation",
    classification: "ZOOM_START_MISMATCH",
    expectedStart: "2026-12-05T03:00:00.000Z",
    expectedDuration: 40,
    returnedStart: "2026-12-05T11:00:00.000Z",
    returnedDuration: 40,
    httpStatus: null,
  });
  const untrusted = createCourtStudySchedulingDiagnostic({
    requestId: "private@example.test",
    stage: "secret",
    classification: "secret",
    returnedStart: "https://zoom.us/private-link",
    returnedDuration: "private",
    httpStatus: "private",
  });
  assert.doesNotMatch(JSON.stringify(untrusted), /private|secret|zoom\.us/i);
  const invitation = createCourtStudySchedulingDiagnostic({
    requestId: "test-request",
    stage: "invitation_delivery",
    classification: "INVITATION_OUTCOME_UNCERTAIN",
    expectedStart: "2026-12-05T03:00:00Z",
    expectedDuration: 40,
  });
  assert.equal(invitation.stage, "invitation_delivery");
  assert.equal(invitation.classification, "INVITATION_OUTCOME_UNCERTAIN");
});
