import test from "node:test";
import assert from "node:assert/strict";

import {
  createCourtStudyMeetingWithClaim,
  createUtcScheduleWindow,
  formatCourtStudySetupFailure,
  getScheduledDurationMinutes,
  resolveCourtStudyScheduleDuration,
  resolveCourtStudyInvitationToken,
  resolveZoomCreationDisposition,
  runCourtStudySetupStages,
  runZoomCreationWithClaim,
} from "../courtStudyScheduling.js";

const communityRequest = {
  meetingFormat: "COMMUNITY_HOSTED",
  studyFocusType: "RULES_OF_PROCEDURE",
  durationMinutes: 60,
};

test("community scheduling preserves standard and approved reduced durations", () => {
  assert.equal(
    resolveCourtStudyScheduleDuration(communityRequest),
    60
  );
  assert.equal(
    resolveCourtStudyScheduleDuration(
      communityRequest,
      40
    ),
    40
  );

  for (const durationMinutes of [30, 40, 45, 60, 90]) {
    assert.equal(
      resolveCourtStudyScheduleDuration(
        {
          ...communityRequest,
          studyFocusType: "BOOK_STUDY",
          durationMinutes,
        }
      ),
      durationMinutes
    );
  }

  assert.throws(
    () =>
      resolveCourtStudyScheduleDuration(
        {
          ...communityRequest,
          studyFocusType: "BOOK_STUDY",
          durationMinutes: 30,
        },
        40
      ),
    /reduction to 40 minutes/
  );
});

test("UTC schedule windows retain exact duration across timezone transitions", () => {
  const window = createUtcScheduleWindow(
    "2026-03-08T09:30:00.000Z",
    60
  );

  assert.deepEqual(window, {
    scheduledStart: "2026-03-08T09:30:00.000Z",
    scheduledEnd: "2026-03-08T10:30:00.000Z",
  });
  assert.equal(
    getScheduledDurationMinutes(
      window.scheduledStart,
      window.scheduledEnd
    ),
    60
  );
  assert.throws(
    () =>
      getScheduledDurationMinutes(
        window.scheduledStart,
        "2026-03-08T10:30:30.000Z"
      ),
    /whole-minute/
  );
});

test("invalid community duration and unsupported study types are rejected", () => {
  assert.throws(
    () =>
      resolveCourtStudyScheduleDuration({
        ...communityRequest,
        studyFocusType: "BOOK_STUDY",
        durationMinutes: 41,
      }),
    /duration must be/
  );
  assert.throws(
    () =>
      resolveCourtStudyScheduleDuration({
        ...communityRequest,
        studyFocusType: "FOCUS_GROUP",
      }),
    /Unsupported/
  );
  assert.throws(
    () =>
      resolveCourtStudyScheduleDuration({
        ...communityRequest,
        meetingFormat: "COURT_HOSTED",
      }),
    /community-hosted/
  );
});

test("a request claim permits only one scheduled meeting creation", async () => {
  const request = { status: "APPROVED" };
  let createdMeetings = 0;

  const claim = async () => {
    if (request.status !== "APPROVED") {
      return { count: 0 };
    }

    request.status = "SCHEDULED";
    return { count: 1 };
  };
  const createMeeting = async () => {
    createdMeetings += 1;
    return { id: "meeting-1" };
  };

  const results = await Promise.allSettled([
    createCourtStudyMeetingWithClaim({
      claim,
      createMeeting,
    }),
    createCourtStudyMeetingWithClaim({
      claim,
      createMeeting,
    }),
  ]);

  assert.equal(createdMeetings, 1);
  assert.equal(
    results.filter((result) => result.status === "fulfilled")
      .length,
    1
  );
  assert.equal(
    results.find((result) => result.status === "rejected")
      .reason.code,
    "COURT_STUDY_SCHEDULE_CLAIM_LOST"
  );
});

test("meeting creation errors propagate for the surrounding transaction to roll back", async () => {
  const error = new Error("database create failed");
  let created = false;

  await assert.rejects(
    createCourtStudyMeetingWithClaim({
      claim: async () => ({ count: 1 }),
      createMeeting: async () => {
        created = true;
        throw error;
      },
    }),
    error
  );
  assert.equal(created, true);
});

test("concurrent invitation attempts converge on the persisted token", async () => {
  let persistedToken = null;
  let tokenSequence = 0;
  const resolveToken = () =>
    resolveCourtStudyInvitationToken({
      currentToken: null,
      createToken: () => `candidate-${++tokenSequence}`,
      claimToken: async (candidate) => {
        if (persistedToken) {
          return { count: 0 };
        }

        persistedToken = candidate;
        return { count: 1 };
      },
      loadToken: async () => persistedToken,
    });

  const tokens = await Promise.all([
    resolveToken(),
    resolveToken(),
  ]);

  assert.equal(tokens[0], tokens[1]);
  assert.equal(tokens[0], persistedToken);
});

test("Zoom creation disposition blocks stale states and reuses saved meetings", () => {
  assert.equal(
    resolveZoomCreationDisposition({
      requestStatus: "SCHEDULED",
      meetingStatus: "SCHEDULED",
    }),
    "CLAIM"
  );
  assert.equal(
    resolveZoomCreationDisposition({
      requestStatus: "SCHEDULED",
      meetingStatus: "CREATING",
    }),
    "IN_PROGRESS_OR_RECONCILIATION_REQUIRED"
  );
  assert.equal(
    resolveZoomCreationDisposition({
      requestStatus: "COMPLETED",
      meetingStatus: "SCHEDULED",
    }),
    "INELIGIBLE"
  );
  assert.equal(
    resolveZoomCreationDisposition({
      requestStatus: "COMPLETED",
      meetingStatus: "SCHEDULED",
      zoomMeetingId: "zoom-123",
    }),
    "EXISTS"
  );
});

test("concurrent Zoom creation claims dispatch only one external creation", async () => {
  const meeting = {
    status: "SCHEDULED",
    zoomMeetingId: null,
  };
  let externalCreateCalls = 0;
  let finishCreation;

  const execute = () =>
    runZoomCreationWithClaim({
      claim: async () => {
        if (meeting.status !== "SCHEDULED") {
          return false;
        }
        meeting.status = "CREATING";
        return true;
      },
      create: async (markDispatched) => {
        markDispatched();
        externalCreateCalls += 1;
        await new Promise((resolve) => {
          finishCreation = resolve;
        });
        return {
          success: true,
          value: { id: "zoom-123" },
        };
      },
      persist: async ({ id }) => {
        meeting.zoomMeetingId = id;
        meeting.status = "SCHEDULED";
      },
      release: async () => {
        meeting.status = "SCHEDULED";
      },
      markDefinitiveFailure: async () => {
        meeting.status = "FAILED";
      },
    });

  const first = execute();
  await Promise.resolve();
  const second = await execute();

  assert.equal(second.state, "NOT_CLAIMED");
  assert.equal(externalCreateCalls, 1);

  finishCreation();
  assert.equal((await first).state, "CREATED");
  assert.equal(meeting.zoomMeetingId, "zoom-123");
});

test("definitive Zoom rejection marks failure and permits a deliberate retry", async () => {
  const meeting = { status: "SCHEDULED" };
  let externalCreateCalls = 0;

  const execute = (succeeds) =>
    runZoomCreationWithClaim({
      claim: async () => {
        if (!["SCHEDULED", "FAILED"].includes(meeting.status)) {
          return false;
        }
        meeting.status = "CREATING";
        return true;
      },
      create: async (markDispatched) => {
        markDispatched();
        externalCreateCalls += 1;
        return succeeds
          ? { success: true, value: { id: "zoom-123" } }
          : {
              success: false,
              definitive: true,
              statusCode: 400,
              error: "Zoom rejected the request",
            };
      },
      persist: async ({ id }) => {
        meeting.zoomMeetingId = id;
        meeting.status = "SCHEDULED";
      },
      release: async () => {
        meeting.status = "SCHEDULED";
      },
      markDefinitiveFailure: async () => {
        meeting.status = "FAILED";
      },
    });

  assert.equal(
    (await execute(false)).state,
    "DEFINITIVE_FAILURE"
  );
  assert.equal(meeting.status, "FAILED");
  assert.equal((await execute(true)).state, "CREATED");
  assert.equal(externalCreateCalls, 2);
});

test("ambiguous Zoom outcome remains claimed and cannot be blindly retried", async () => {
  const meeting = { status: "SCHEDULED" };
  let externalCreateCalls = 0;

  const execute = () =>
    runZoomCreationWithClaim({
      claim: async () => {
        if (meeting.status !== "SCHEDULED") {
          return false;
        }
        meeting.status = "CREATING";
        return true;
      },
      create: async (markDispatched) => {
        markDispatched();
        externalCreateCalls += 1;
        throw new Error("network outcome unknown");
      },
      persist: async () => {},
      release: async () => {
        meeting.status = "SCHEDULED";
      },
      markDefinitiveFailure: async () => {
        meeting.status = "FAILED";
      },
    });

  assert.equal((await execute()).state, "AMBIGUOUS");
  assert.equal(meeting.status, "CREATING");
  assert.equal((await execute()).state, "NOT_CLAIMED");
  assert.equal(externalCreateCalls, 1);
});

test("Zoom success followed by persistence failure requires reconciliation", async () => {
  const meeting = { status: "SCHEDULED" };
  let externalCreateCalls = 0;

  const execute = () =>
    runZoomCreationWithClaim({
      claim: async () => {
        if (meeting.status !== "SCHEDULED") {
          return false;
        }
        meeting.status = "CREATING";
        return true;
      },
      create: async (markDispatched) => {
        markDispatched();
        externalCreateCalls += 1;
        return {
          success: true,
          value: { id: "zoom-123" },
        };
      },
      persist: async () => {
        throw new Error("database persistence failed");
      },
      release: async () => {
        meeting.status = "SCHEDULED";
      },
      markDefinitiveFailure: async () => {
        meeting.status = "FAILED";
      },
    });

  assert.equal((await execute()).state, "AMBIGUOUS");
  assert.equal(meeting.status, "CREATING");
  assert.equal((await execute()).state, "NOT_CLAIMED");
  assert.equal(externalCreateCalls, 1);
});

test("a Zoom rejection before dispatch releases the claim for retry", async () => {
  const meeting = { status: "SCHEDULED" };
  let externalCreateCalls = 0;

  const execute = () =>
    runZoomCreationWithClaim({
      claim: async () => {
        if (meeting.status !== "SCHEDULED") {
          return false;
        }
        meeting.status = "CREATING";
        return true;
      },
      create: async () => {
        return {
          success: false,
          statusCode: 503,
          error: "Token unavailable before meeting request",
        };
      },
      persist: async () => {},
      release: async () => {
        meeting.status = "SCHEDULED";
      },
      markDefinitiveFailure: async () => {
        meeting.status = "FAILED";
      },
    });

  assert.equal(
    (await execute()).state,
    "PREPARATION_FAILED"
  );
  assert.equal(meeting.status, "SCHEDULED");
  assert.equal(externalCreateCalls, 0);
});

test("setup stops after scheduling, Zoom, or invitation failure", async () => {
  let zoomCalls = 0;
  let invitationCalls = 0;

  const schedulingFailure =
    await runCourtStudySetupStages({
      schedule: async () => ({
        success: false,
        error: "scheduling failed",
      }),
      createZoom: async () => {
        zoomCalls += 1;
      },
      sendInvitation: async () => {
        invitationCalls += 1;
      },
    });

  assert.equal(schedulingFailure.failedStage, "SCHEDULING");
  assert.equal(zoomCalls, 0);
  assert.equal(invitationCalls, 0);

  const zoomFailure = await runCourtStudySetupStages({
    schedule: async () => ({ success: true }),
    createZoom: async () => {
      zoomCalls += 1;
      return {
        responseBody: {
          success: false,
          error: "Zoom creation failed",
        },
      };
    },
    sendInvitation: async () => {
      invitationCalls += 1;
    },
  });

  assert.equal(zoomFailure.failedStage, "ZOOM_CREATION");
  assert.equal(zoomCalls, 1);
  assert.equal(invitationCalls, 0);

  const invitationFailure =
    await runCourtStudySetupStages({
      schedule: async () => ({ success: true }),
      createZoom: async () => ({
        responseBody: { success: true },
      }),
      sendInvitation: async () => ({
        success: false,
        responseBody: {
          success: false,
          error: "invitation delivery uncertain",
        },
      }),
    });

  assert.equal(
    invitationFailure.failedStage,
    "INVITATION"
  );
});

test("setup failure messages distinguish creation and invitation outcomes", async () => {
  const schedulingFailure =
    await runCourtStudySetupStages({
      schedule: async () => ({ success: false }),
      createZoom: async () => {
        assert.fail("Zoom creation must not follow failed scheduling");
      },
      sendInvitation: async () => {
        assert.fail("Invitation delivery must not follow failed scheduling");
      },
    });

  assert.equal(schedulingFailure.failureType, "SCHEDULING_FAILED");
  assert.match(
    formatCourtStudySetupFailure({
      studyName: "Court Study",
      failureType: schedulingFailure.failureType,
    }),
    /did not create a Zoom meeting/
  );

  const zoomFailure = await runCourtStudySetupStages({
    schedule: async () => ({ success: true }),
    createZoom: async () => ({
      statusCode: 400,
      responseBody: {
        success: false,
        noMeetingCreated: true,
        error: "private external error",
      },
    }),
    sendInvitation: async () => {
      assert.fail("Invitation delivery must not follow failed creation");
    },
  });

  assert.equal(zoomFailure.failureType, "ZOOM_NOT_CREATED");
  const zoomMessage = formatCourtStudySetupFailure({
    studyName: "Book Study",
    failureType: zoomFailure.failureType,
  });
  assert.match(zoomMessage, /Zoom did not create its meeting/);
  assert.doesNotMatch(zoomMessage, /private external error/);

  const uncertainCreation = await runCourtStudySetupStages({
    schedule: async () => ({ success: true }),
    createZoom: async () => ({
      statusCode: 502,
      responseBody: {
        success: false,
        reconciliationRequired: true,
      },
    }),
    sendInvitation: async () => {
      assert.fail("Invitation delivery must not follow uncertain creation");
    },
  });

  assert.equal(
    uncertainCreation.failureType,
    "ZOOM_OUTCOME_UNCERTAIN"
  );
  assert.match(
    formatCourtStudySetupFailure({
      studyName: "Court Study",
      failureType: uncertainCreation.failureType,
    }),
    /Do not retry/
  );

  const invitationFailure = await runCourtStudySetupStages({
    schedule: async () => ({ success: true }),
    createZoom: async () => ({
      responseBody: { success: true },
    }),
    sendInvitation: async () => ({
      success: false,
      responseBody: {
        success: false,
        deliveryMayHaveOccurred: true,
      },
    }),
  });

  assert.equal(
    invitationFailure.failureType,
    "INVITATION_OUTCOME_UNCERTAIN"
  );
  assert.match(
    formatCourtStudySetupFailure({
      studyName: "Book Study",
      failureType: invitationFailure.failureType,
      durationMinutes: 40,
    }),
    /invitation delivery is uncertain/
  );
  assert.match(
    formatCourtStudySetupFailure({
      studyName: "Book Study",
      failureType: invitationFailure.failureType,
    }),
    /Book Study/
  );

  const undeliveredInvitation =
    await runCourtStudySetupStages({
      schedule: async () => ({ success: true }),
      createZoom: async () => ({
        responseBody: { success: true },
      }),
      sendInvitation: async () => ({
        success: false,
        responseBody: {
          success: false,
          deliveryMayHaveOccurred: false,
        },
      }),
    });

  assert.equal(
    undeliveredInvitation.failureType,
    "INVITATION_NOT_SENT"
  );
  assert.match(
    formatCourtStudySetupFailure({
      studyName: "Court Study",
      failureType: undeliveredInvitation.failureType,
    }),
    /invitation was not sent/
  );
});

test("retry reuses an existing Zoom meeting and retries only invitation delivery", async () => {
  let externalZoomCreations = 0;
  let invitations = 0;

  const firstAttempt = await runCourtStudySetupStages({
    schedule: async () => ({
      success: true,
      meeting: { id: "meeting-1" },
    }),
    createZoom: async () => {
      externalZoomCreations += 1;
      return {
        responseBody: { success: true },
      };
    },
    sendInvitation: async () => {
      invitations += 1;
      return {
        success: false,
        responseBody: { success: false },
      };
    },
  });

  assert.equal(firstAttempt.failedStage, "INVITATION");

  const retry = await runCourtStudySetupStages({
    schedule: async () => ({
      success: true,
      meeting: { id: "meeting-1" },
    }),
    createZoom: async () => ({
      responseBody: {
        success: true,
        idempotent: true,
      },
    }),
    sendInvitation: async () => {
      invitations += 1;
      return {
        success: true,
        responseBody: { success: true },
      };
    },
  });

  assert.equal(retry.success, true);
  assert.equal(externalZoomCreations, 1);
  assert.equal(invitations, 2);
});

test("setup does not resend an invitation already recorded as sent", async () => {
  let invitations = 0;

  const result = await runCourtStudySetupStages({
    schedule: async () => ({
      success: true,
      meeting: {
        id: "meeting-1",
        invitationSentAt: "2026-01-01T00:00:00.000Z",
      },
    }),
    createZoom: async () => ({
      responseBody: { success: true, idempotent: true },
    }),
    sendInvitation: async () => {
      invitations += 1;
      return { success: true };
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.invitationResult.responseBody.skipped, true);
  assert.equal(invitations, 0);
});
