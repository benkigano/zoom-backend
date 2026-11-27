import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyCourtStudyOAuthCallbackState,
  createCourtStudyWorkflowGate,
  getCourtStudyWorkflowRoute,
  isCommunityHostedStudyRequest,
  parseCourtStudyWorkflowConfiguration,
} from "../courtStudyWorkflowGate.js";

function configuration(mode, testRequestIds) {
  const env = {
    COURT_STUDY_WORKFLOW_MODE: mode,
  };

  if (testRequestIds !== undefined) {
    env.COURT_STUDY_WORKFLOW_TEST_REQUEST_IDS =
      testRequestIds;
  }

  return parseCourtStudyWorkflowConfiguration(env);
}

function createGate(mode, testRequestIds) {
  const parsed = configuration(mode, testRequestIds);
  return createCourtStudyWorkflowGate({
    getConfiguration: () => parsed,
  });
}

test("normal mode admits affected operations", async () => {
  const gate = createGate("NORMAL");
  let calls = 0;

  const result = await gate.run("request-1", async () => {
    calls += 1;
    return "completed";
  });

  assert.deepEqual(result, {
    admitted: true,
    value: "completed",
  });
  assert.equal(calls, 1);
  assert.equal(gate.getActiveOperationCount(), 0);
});

test("paused mode rejects operations before their side effects", async () => {
  const gate = createGate("PAUSED");
  let externalSideEffects = 0;

  const result = await gate.run("request-1", async () => {
    externalSideEffects += 1;
  });

  assert.equal(result.admitted, false);
  assert.equal(result.reason, "PAUSED");
  assert.equal(externalSideEffects, 0);
});

test("controlled testing admits only exact configured request IDs", async () => {
  const gate = createGate(
    "CONTROLLED_TESTING",
    "request-1, request-2"
  );
  let admittedCalls = 0;

  const allowed = await gate.run("request-1", async () => {
    admittedCalls += 1;
  });
  const prefixMismatch = await gate.run(
    "request-10",
    async () => {
      admittedCalls += 1;
    }
  );
  const whitespaceMismatch = await gate.run(
    "request-1 ",
    async () => {
      admittedCalls += 1;
    }
  );

  assert.equal(allowed.admitted, true);
  assert.equal(prefixMismatch.admitted, false);
  assert.equal(
    prefixMismatch.reason,
    "REQUEST_NOT_ALLOWLISTED"
  );
  assert.equal(whitespaceMismatch.admitted, false);
  assert.equal(admittedCalls, 1);
});

test("missing and malformed configuration fails closed", async () => {
  const invalidConfigurations = [
    parseCourtStudyWorkflowConfiguration({}),
    configuration("unknown"),
    configuration("normal"),
    configuration(" NORMAL "),
    configuration("CONTROLLED_TESTING"),
    configuration("CONTROLLED_TESTING", "request-1,,request-2"),
    configuration("CONTROLLED_TESTING", "request-1,request-1"),
    configuration("NORMAL", "request-1"),
    configuration("NORMAL", "   "),
  ];

  for (const parsed of invalidConfigurations) {
    assert.equal(parsed.valid, false);
    const gate = createCourtStudyWorkflowGate({
      getConfiguration: () => parsed,
    });
    let called = false;

    const result = await gate.run("request-1", async () => {
      called = true;
    });

    assert.equal(result.admitted, false);
    assert.equal(
      result.reason,
      "CONFIGURATION_INVALID"
    );
    assert.equal(called, false);
  }
});

test("shared OAuth callback classification gates only study state", () => {
  assert.deepEqual(
    classifyCourtStudyOAuthCallbackState({
      requestId: "request-1",
      organizerEmail: "organizer@example.org",
      invitationToken: "legacy-token",
    }),
    {
      kind: "STUDY",
      requestId: "request-1",
    }
  );

  assert.deepEqual(
    classifyCourtStudyOAuthCallbackState({
      requestId: "request-1",
      organizerEmail: "organizer@example.org",
      invitationToken: "new-token",
      studyRecheck: false,
      studyContext: {},
      studyAuthorizationSignature: "signature",
    }),
    {
      kind: "STUDY",
      requestId: "request-1",
    }
  );

  for (const unrelatedState of [
    {
      churchContactId: "contact-1",
      invitationToken: "contact-token",
    },
    {
      organizerEmail: "reviewer@example.org",
      invitationToken: "reviewer-token",
      reviewerFlow: true,
    },
    {
      organizerEmail: "organizer@example.org",
      invitationToken: "reauth-token",
      reauthOnly: true,
    },
  ]) {
    assert.equal(
      classifyCourtStudyOAuthCallbackState(unrelatedState)
        .kind,
      "UNRELATED"
    );
  }

  for (const ambiguousState of [
    {
      requestId: "request-1",
      churchContactId: "contact-1",
      organizerEmail: "organizer@example.org",
      invitationToken: "token",
    },
    {
      studyRecheck: true,
      organizerEmail: "organizer@example.org",
      invitationToken: "token",
    },
    {
      requestId: "request-1",
      organizerEmail: "organizer@example.org",
    },
  ]) {
    assert.equal(
      classifyCourtStudyOAuthCallbackState(ambiguousState)
        .kind,
      "AMBIGUOUS"
    );
  }
});

test("only setup-changing routes are gate-covered", () => {
  assert.equal(
    getCourtStudyWorkflowRoute(
      "GET",
      "/court-study/zoom/authorize-organizer/:requestId"
    ).lookupCommunityRequest,
    true
  );
  assert.equal(
    getCourtStudyWorkflowRoute(
      "GET",
      [
        "/court-study/zoom/callback",
        "/court-study/zoom/callback/dev",
      ]
    ).sharedOAuthCallback,
    true
  );
  assert.equal(
    getCourtStudyWorkflowRoute(
      "POST",
      "/api/book-study/use-basic-duration"
    ).requestIdSource,
    "body.requestId"
  );

  for (const [method, path] of [
    ["POST", "/api/court-study-requests/:id/schedule"],
    ["POST", "/api/court-study-requests/:id/create-zoom"],
    [
      "POST",
      "/api/court-study-requests/:id/send-invitation",
    ],
    [
      "POST",
      "/court-study/zoom/test-create-organizer-meeting/:requestId",
    ],
  ]) {
    assert.ok(getCourtStudyWorkflowRoute(method, path));
  }

  assert.equal(
    getCourtStudyWorkflowRoute(
      "POST",
      "/api/court-study-requests/:id/manual-zoom"
    ).trackingOnly,
    true
  );

  for (const [method, path] of [
    ["POST", "/zoom/webhook"],
    ["POST", "/api/stripe/webhook"],
    ["POST", "/court-study/participant-register"],
    ["POST", "/court-study/reflection"],
    ["GET", "/court-study/zoom/connect-organizer/:requestId"],
  ]) {
    assert.equal(
      getCourtStudyWorkflowRoute(method, path),
      null
    );
  }

  assert.equal(
    isCommunityHostedStudyRequest({
      meetingFormat: "COMMUNITY_HOSTED",
    }),
    true
  );
  assert.equal(
    isCommunityHostedStudyRequest({
      meetingFormat: "COURT_HOSTED",
    }),
    false
  );
});

test("manual reconciliation tracking is independent of workflow mode", async () => {
  const pausedGate = createGate("PAUSED");
  const controlledGate = createGate(
    "CONTROLLED_TESTING",
    "allowed-request"
  );

  for (const gate of [pausedGate, controlledGate]) {
    const result = await gate.runTracked(async () => "reconciled");
    assert.deepEqual(result, {
      admitted: true,
      value: "reconciled",
    });
    assert.equal(gate.getActiveOperationCount(), 0);
  }
});

test("manual reconciliation remains active until async work completes", async () => {
  const gate = createGate("PAUSED");
  let finishReconciliation;

  const reconciliation = gate.runTracked(
    () =>
      new Promise((resolve) => {
        finishReconciliation = resolve;
      })
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.getActiveOperationCount(), 1);
  assert.deepEqual(await gate.waitForDrain(1), {
    drained: false,
    activeOperations: 1,
  });

  finishReconciliation("saved");
  assert.deepEqual(await reconciliation, {
    admitted: true,
    value: "saved",
  });
  assert.deepEqual(await gate.waitForDrain(10), {
    drained: true,
    activeOperations: 0,
  });
});

test("manual reconciliation exceptions release their operation count", async () => {
  const gate = createGate("CONTROLLED_TESTING", "allowed-request");

  await assert.rejects(
    gate.runTracked(async () => {
      throw new Error("reconciliation failed");
    }),
    /reconciliation failed/
  );

  assert.equal(gate.getActiveOperationCount(), 0);
  assert.deepEqual(await gate.waitForDrain(10), {
    drained: true,
    activeOperations: 0,
  });
});

test("manual reconciliation is rejected after shutdown begins", async () => {
  const gate = createGate("PAUSED");
  let reconciliationStarted = false;
  gate.stopAccepting();

  const result = await gate.runTracked(async () => {
    reconciliationStarted = true;
  });

  assert.deepEqual(result, {
    admitted: false,
    reason: "SHUTTING_DOWN",
  });
  assert.equal(reconciliationStarted, false);
  assert.equal(gate.getActiveOperationCount(), 0);
});

test("tracking-only reconciliation does not bypass study setup restrictions", async () => {
  const pausedGate = createGate("PAUSED");
  const pausedReconciliation =
    await pausedGate.runTracked(async () => "reconciled");
  const pausedSetup = await pausedGate.run(
    "request-1",
    async () => "scheduled"
  );

  const controlledGate = createGate(
    "CONTROLLED_TESTING",
    "allowed-request"
  );
  const controlledReconciliation =
    await controlledGate.runTracked(async () => "reconciled");
  const controlledSetup = await controlledGate.run(
    "other-request",
    async () => "scheduled"
  );

  assert.equal(pausedReconciliation.admitted, true);
  assert.equal(pausedSetup.admitted, false);
  assert.equal(pausedSetup.reason, "PAUSED");
  assert.equal(controlledReconciliation.admitted, true);
  assert.equal(controlledSetup.admitted, false);
  assert.equal(controlledSetup.reason, "REQUEST_NOT_ALLOWLISTED");
});

test("operation tracking lasts until asynchronous work settles", async () => {
  const gate = createGate("NORMAL");
  let finishOperation;
  let sideEffectCompleted = false;

  const operation = gate.run("request-1", () =>
    new Promise((resolve) => {
      finishOperation = () => {
        sideEffectCompleted = true;
        resolve("done");
      };
    })
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.getActiveOperationCount(), 1);

  const pendingDrain = gate.waitForDrain(100);
  assert.equal(gate.getActiveOperationCount(), 1);
  assert.equal(sideEffectCompleted, false);

  finishOperation();
  assert.deepEqual(await operation, {
    admitted: true,
    value: "done",
  });
  assert.deepEqual(await pendingDrain, {
    drained: true,
    activeOperations: 0,
  });
  assert.equal(sideEffectCompleted, true);
});

test("shutdown stops admissions and waits for active operations", async () => {
  const gate = createGate("NORMAL");
  let finishOperation;

  const operation = gate.run("request-1", () =>
    new Promise((resolve) => {
      finishOperation = resolve;
    })
  );

  await new Promise((resolve) => setImmediate(resolve));
  gate.stopAccepting();

  const rejected = await gate.run("request-2", async () => {
    assert.fail("shutdown must reject new operations");
  });
  assert.equal(rejected.admitted, false);
  assert.equal(rejected.reason, "SHUTTING_DOWN");

  const drain = gate.waitForDrain(100);
  finishOperation("finished");
  await operation;
  assert.deepEqual(await drain, {
    drained: true,
    activeOperations: 0,
  });
});

test("drain timeout preserves uncertain creation state", async () => {
  const gate = createGate("NORMAL");
  const meeting = { status: "CREATING" };
  let finishOperation;

  const operation = gate.run("request-1", () =>
    new Promise((resolve) => {
      finishOperation = resolve;
    })
  );

  await new Promise((resolve) => setImmediate(resolve));
  gate.stopAccepting();

  const drain = await gate.waitForDrain(1);
  assert.deepEqual(drain, {
    drained: false,
    activeOperations: 1,
  });
  assert.deepEqual(meeting, { status: "CREATING" });
  assert.equal(gate.getActiveOperationCount(), 1);

  finishOperation();
  await operation;
  assert.deepEqual(meeting, { status: "CREATING" });
});
