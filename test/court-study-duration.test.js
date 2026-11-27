import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyZoomAccountType,
  createBasicDurationAuthorizationToken,
  createCommunityStudyOAuthRequestContext,
  createCommunityStudyOAuthStateSignature,
  hasConflictingOAuthCallbackRouting,
  matchesCommunityStudyOAuthRequestContext,
  normalizeZoomIdentityEmail,
  requiresZoomBasicDurationChoice,
  resolveBasicDurationContinuationRequest,
  resolveCommunityHostedZoomDurationDecision,
  resolveCommunityHostedStudyDuration,
  resolveCommunityStudyZoomAuthorizationMode,
  verifyBasicDurationAuthorizationToken,
  verifyCommunityStudyOAuthStateSignature,
} from "../courtStudyDuration.js";

const communityRequest = {
  meetingFormat: "COMMUNITY_HOSTED",
  status: "ZOOM_CONNECTED",
  studyFocusType: "RULES_OF_PROCEDURE",
};

const authorizationContext = {
  requestId: "request-123",
  organizerEmail: "organizer@example.com",
  oauthEnvironment: "DEVELOPMENT",
  zoomUserId: "zoom-user-456",
};

const approvedStudyRequest = {
  ...communityRequest,
  id: "study-request-123",
  organizerEmail: "organizer@example.com",
  status: "APPROVED",
  studyFocusType: "BOOK_STUDY",
  durationMinutes: 60,
  zoomOAuthEnvironment: null,
  preferredStart: new Date("2026-12-01T18:00:00.000Z"),
  timezone: "America/Los_Angeles",
  courtStudyMeeting: null,
};

function createSignedStudyState(
  request = approvedStudyRequest,
  {
    oauthEnvironment = "PRODUCTION",
    invitationToken = "coc-study-v1.one-time-invitation",
    studyRecheck = false,
  } = {}
) {
  const state = {
    requestId: request.id,
    organizerEmail: request.organizerEmail,
    oauthEnvironment,
    invitationToken,
    studyRecheck,
    studyContext: createCommunityStudyOAuthRequestContext(
      request,
      {
        oauthEnvironment,
        invitationToken,
        studyRecheck,
      }
    ),
  };

  state.studyAuthorizationSignature =
    createCommunityStudyOAuthStateSignature({
      ...state,
      secret: "test-secret",
    });

  return state;
}

test("Rules of Procedure community studies use the standard 60 minutes", () => {
  assert.equal(
    resolveCommunityHostedStudyDuration(communityRequest),
    60
  );
});

test("eligible Interview Recording community studies retain 60 minutes", () => {
  assert.equal(
    resolveCommunityHostedStudyDuration({
      ...communityRequest,
      studyFocusType: "INTERVIEW_RECORDING",
    }),
    60
  );
});

test("Book Study permits the configured durations", () => {
  for (const durationMinutes of [30, 40, 45, 60, 90]) {
    assert.equal(
      resolveCommunityHostedStudyDuration({
        ...communityRequest,
        studyFocusType: "BOOK_STUDY",
        durationMinutes,
      }),
      durationMinutes
    );
  }
});

test("Book Study rejects invalid durations", () => {
  for (const durationMinutes of [0, 35, 41, 120, null]) {
    assert.throws(
      () =>
        resolveCommunityHostedStudyDuration({
          ...communityRequest,
          studyFocusType: "BOOK_STUDY",
          durationMinutes,
        }),
      /duration must be/
    );
  }
});

test("unsupported study types and non-community requests are rejected", () => {
  assert.throws(
    () =>
      resolveCommunityHostedStudyDuration({
        ...communityRequest,
        studyFocusType: "FOCUS_GROUP",
      }),
    /Unsupported/
  );

  assert.throws(
    () =>
      resolveCommunityHostedStudyDuration({
        ...communityRequest,
        meetingFormat: "COURT_HOSTED",
      }),
    /community-hosted/
  );
});

test("only explicit Basic and licensed account types are recognized", () => {
  assert.equal(classifyZoomAccountType(1), "BASIC");
  assert.equal(classifyZoomAccountType("2"), "PAID");

  for (const type of [
    undefined,
    null,
    "",
    0,
    3,
    99,
    true,
    "paid",
  ]) {
    assert.equal(classifyZoomAccountType(type), "UNKNOWN");
  }
});

test("duration choices are offered only to Basic accounts over 40 minutes", () => {
  assert.equal(
    requiresZoomBasicDurationChoice(communityRequest, "BASIC"),
    true
  );
  assert.equal(
    requiresZoomBasicDurationChoice(communityRequest, "PAID"),
    false
  );
  assert.equal(
    requiresZoomBasicDurationChoice(communityRequest, "UNKNOWN"),
    false
  );

  for (const durationMinutes of [30, 40]) {
    assert.equal(
      requiresZoomBasicDurationChoice(
        {
          ...communityRequest,
          studyFocusType: "BOOK_STUDY",
          durationMinutes,
        },
        "BASIC"
      ),
      false
    );

    assert.throws(
      () =>
        resolveBasicDurationContinuationRequest({
          ...communityRequest,
          studyFocusType: "BOOK_STUDY",
          durationMinutes,
        }),
      /does not require/
    );
  }

  for (const durationMinutes of [45, 60, 90]) {
    assert.equal(
      requiresZoomBasicDurationChoice(
        {
          ...communityRequest,
          studyFocusType: "BOOK_STUDY",
          durationMinutes,
        },
        "BASIC"
      ),
      true
    );
  }
});

test("initial authorization and study-specific recheck require their own request states", () => {
  assert.deepEqual(
    resolveCommunityStudyZoomAuthorizationMode(
      approvedStudyRequest
    ),
    {
      mode: "INITIAL",
      requestedDurationMinutes: 60,
    }
  );
  assert.deepEqual(
    resolveCommunityStudyZoomAuthorizationMode(
      {
        ...approvedStudyRequest,
        status: "ZOOM_CONNECTED",
      },
      { studyRecheck: true }
    ),
    {
      mode: "STUDY_RECHECK",
      requestedDurationMinutes: 60,
    }
  );

  assert.throws(
    () =>
      resolveCommunityStudyZoomAuthorizationMode(
        {
          ...approvedStudyRequest,
          status: "ZOOM_CONNECTED",
        }
      ),
    /not currently approved/
  );
  assert.throws(
    () =>
      resolveCommunityStudyZoomAuthorizationMode(
        approvedStudyRequest,
        { studyRecheck: true }
      ),
    /not currently waiting/
  );
});

test("study OAuth state signature binds request, organizer, invitation, environment, and recheck mode", () => {
  const secret = "test-secret";
  const signedState = createSignedStudyState(
    {
      ...approvedStudyRequest,
      status: "ZOOM_CONNECTED",
    },
    {
      oauthEnvironment: "DEVELOPMENT",
      studyRecheck: true,
    }
  );

  assert.equal(
    verifyCommunityStudyOAuthStateSignature(
      signedState,
      secret
    ),
    true
  );

  for (const changedField of [
    { requestId: "other-request" },
    { organizerEmail: "other@example.com" },
    { oauthEnvironment: "PRODUCTION" },
    { invitationToken: "different-invitation" },
    { studyRecheck: false },
    {
      studyContext: {
        ...signedState.studyContext,
        studyFocusType: "RULES_OF_PROCEDURE",
      },
    },
  ]) {
    assert.equal(
      verifyCommunityStudyOAuthStateSignature(
        { ...signedState, ...changedField },
        secret
      ),
      false
    );
  }
});

test("study OAuth context rejects changed study and scheduling details", () => {
  const state = createSignedStudyState();

  assert.equal(
    matchesCommunityStudyOAuthRequestContext(
      state,
      approvedStudyRequest
    ),
    true
  );
  assert.equal(
    matchesCommunityStudyOAuthRequestContext(state, {
      ...approvedStudyRequest,
      preferredStart: "2026-12-01T18:00:00.000Z",
      timezone: " America/Los_Angeles ",
      zoomOAuthEnvironment: undefined,
    }),
    true
  );

  const changedRequests = [
    {
      ...approvedStudyRequest,
      studyFocusType: "RULES_OF_PROCEDURE",
    },
    {
      ...approvedStudyRequest,
      durationMinutes: 90,
    },
    {
      ...approvedStudyRequest,
      preferredStart: new Date("2026-12-02T18:00:00.000Z"),
    },
    {
      ...approvedStudyRequest,
      timezone: "America/New_York",
    },
    {
      ...approvedStudyRequest,
      organizerEmail: "another@example.com",
    },
    {
      ...approvedStudyRequest,
      zoomOAuthEnvironment: "DEVELOPMENT",
    },
    {
      ...approvedStudyRequest,
      status: "ZOOM_CONNECTED",
    },
    {
      ...approvedStudyRequest,
      meetingFormat: "COURT_HOSTED",
    },
    {
      ...approvedStudyRequest,
      courtStudyMeeting: { id: "meeting-123" },
    },
  ];

  for (const changedRequest of changedRequests) {
    assert.equal(
      matchesCommunityStudyOAuthRequestContext(
        state,
        changedRequest
      ),
      false
    );
  }
});

test("study OAuth routing rejects injected cross-workflow flags", () => {
  const state = createSignedStudyState();

  assert.equal(
    hasConflictingOAuthCallbackRouting(state),
    false
  );

  for (const injectedRouting of [
    { reviewerFlow: true },
    { reviewerFlow: false },
    { churchContactId: "church-contact-123" },
    { churchContactId: "" },
    { reauthOnly: true },
    { reauthOnly: false },
  ]) {
    assert.equal(
      hasConflictingOAuthCallbackRouting({
        ...state,
        ...injectedRouting,
      }),
      true
    );
  }

  const downgradedState = { ...state };
  delete downgradedState.requestId;
  delete downgradedState.studyAuthorizationSignature;
  delete downgradedState.studyRecheck;
  delete downgradedState.studyContext;

  assert.equal(
    hasConflictingOAuthCallbackRouting({
      ...downgradedState,
      reauthOnly: true,
      reviewerFlow: true,
    }),
    true
  );

  assert.equal(
    hasConflictingOAuthCallbackRouting({
      organizerEmail: "reviewer@example.com",
      invitationToken: "reviewer-invitation",
      reauthOnly: true,
      reviewerFlow: true,
    }),
    false
  );
  assert.equal(
    hasConflictingOAuthCallbackRouting({
      churchContactId: "church-contact-123",
      invitationToken: "church-invitation",
      reviewerFlow: true,
    }),
    true
  );
  assert.equal(
    hasConflictingOAuthCallbackRouting({
      churchContactId: "church-contact-123",
      invitationToken: "church-invitation",
    }),
    false
  );
});

test("Basic recheck returns to a fresh duration choice while paid retains intended duration", () => {
  const recheckRequest = {
    ...approvedStudyRequest,
    status: "ZOOM_CONNECTED",
  };

  assert.deepEqual(
    resolveCommunityHostedZoomDurationDecision(
      recheckRequest,
      "BASIC"
    ),
    {
      requestedDurationMinutes: 60,
      requiresBasicDurationChoice: true,
      scheduledDurationMinutes: null,
    }
  );
  assert.deepEqual(
    resolveCommunityHostedZoomDurationDecision(
      recheckRequest,
      "PAID"
    ),
    {
      requestedDurationMinutes: 60,
      requiresBasicDurationChoice: false,
      scheduledDurationMinutes: 60,
    }
  );
  assert.throws(
    () =>
      resolveCommunityHostedZoomDurationDecision(
        recheckRequest,
        "UNKNOWN"
      ),
    /not verified/
  );
});

test("community study recheck preserves Gmail alias identity normalization", () => {
  assert.equal(
    normalizeZoomIdentityEmail("Organizer+study@googlemail.com"),
    "organizer@gmail.com"
  );
  assert.equal(
    normalizeZoomIdentityEmail("Organizer+study@outlook.com"),
    "organizer+study@outlook.com"
  );
});

test("duration continuation requires an eligible over-40 request and waiting status", () => {
  assert.equal(
    resolveBasicDurationContinuationRequest(communityRequest),
    60
  );

  for (const status of ["APPROVED", "SCHEDULED", "COMPLETED"]) {
    assert.throws(
      () =>
        resolveBasicDurationContinuationRequest({
          ...communityRequest,
          status,
        }),
      /not currently waiting/
    );
  }

  assert.throws(
    () =>
      resolveBasicDurationContinuationRequest({
        ...communityRequest,
        courtStudyMeeting: { id: "meeting-123" },
      }),
    /already been created/
  );

  assert.throws(
    () =>
      resolveBasicDurationContinuationRequest({
        ...communityRequest,
        studyFocusType: "BOOK_STUDY",
        durationMinutes: 40,
      }),
    /does not require/
  );
});

test("Basic duration authorization is scoped and expires", () => {
  const now = 1_800_000_000_000;
  const token = createBasicDurationAuthorizationToken({
    ...authorizationContext,
    secret: "test-secret",
    now,
  });
  const verificationContext = {
    requestId: authorizationContext.requestId,
    organizerEmail: " Organizer@Example.com ",
    oauthEnvironment: authorizationContext.oauthEnvironment,
    secret: "test-secret",
  };

  assert.equal(
    verifyBasicDurationAuthorizationToken(token, {
      ...verificationContext,
      now: now + 1_000,
    })?.zoomUserId,
    authorizationContext.zoomUserId
  );
  assert.equal(
    verifyBasicDurationAuthorizationToken(token, {
      ...verificationContext,
      requestId: "different-request",
      now: now + 1_000,
    }),
    null
  );
  assert.equal(
    verifyBasicDurationAuthorizationToken(token, {
      ...verificationContext,
      oauthEnvironment: "PRODUCTION",
      now: now + 1_000,
    }),
    null
  );
  assert.equal(
    verifyBasicDurationAuthorizationToken(token, {
      ...verificationContext,
      organizerEmail: "other@example.com",
      now: now + 1_000,
    }),
    null
  );
  assert.equal(
    verifyBasicDurationAuthorizationToken(token, {
      ...verificationContext,
      now: now + 15 * 60 * 1000,
    }),
    null
  );

  const recoverableRequest = {
    ...approvedStudyRequest,
    status: "ZOOM_CONNECTED",
  };
  assert.deepEqual(
    resolveCommunityStudyZoomAuthorizationMode(
      recoverableRequest,
      { studyRecheck: true }
    ),
    {
      mode: "STUDY_RECHECK",
      requestedDurationMinutes: 60,
    }
  );

  assert.equal(
    verifyBasicDurationAuthorizationToken(`${token}x`, {
      ...verificationContext,
      now: now + 1_000,
    }),
    null
  );

  for (const status of ["SCHEDULED", "COMPLETED"]) {
    assert.throws(
      () =>
        resolveCommunityStudyZoomAuthorizationMode(
          {
            ...recoverableRequest,
            status,
          },
          { studyRecheck: true }
        ),
      /not currently waiting/
    );
  }
});
