import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMembershipVerificationUrl,
  createCourtStudyMembershipEnrollmentHandler,
  createCourtStudyMembershipContinuationHandler,
} from "../membership/courtStudyContinuation.js";

const requestId = "court-study-request-1";
const continuationToken = "signed-request-token";

const courtStudyRequest = {
  id: requestId,
  status: "PENDING",
  meetingFormat: "COMMUNITY_HOSTED",
  organizerEmail: " Organizer@Example.com ",
  pastorEmail: null,
  organizerName: "Organizer",
  hostGroupName: "Community",
  preferredStart: new Date("2026-12-01T18:00:00Z"),
  timezone: "UTC",
};

function createResponse() {
  return {
    headers: {},
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function createRequest(body) {
  return { body };
}

function createEnrollmentSetup({
  request = courtStudyRequest,
  activeSubscriber = false,
  tokenIsValid = true,
  verificationStarted = true,
} = {}) {
  const calls = [];
  const prisma = {
    courtStudyRequest: {
      async findUnique(query) {
        calls.push(["findUnique", query]);
        return request;
      },
    },
  };
  const handler = createCourtStudyMembershipEnrollmentHandler({
    prisma,
    verifyContinuationToken: (id, token) =>
      tokenIsValid && id === requestId && token === continuationToken,
    isActiveSubscriberEmail: async (email) => {
      calls.push(["isActiveSubscriberEmail", email]);
      return activeSubscriber;
    },
    requestMembershipVerification: async (...args) => {
      calls.push(["requestMembershipVerification", ...args]);
      return verificationStarted;
    },
    logError: (...args) => calls.push(["logError", ...args]),
  });
  const response = createResponse();

  return {
    calls,
    response,
    run: (body) => handler(createRequest(body), response),
  };
}

function createContinuationSetup({
  request = courtStudyRequest,
  activeSubscriber = true,
  updateCount = 1,
  tokenIsValid = true,
} = {}) {
  const calls = [];
  const prisma = {
    courtStudyRequest: {
      async findUnique(query) {
        calls.push(["findUnique", query]);
        if (query.select) {
          return { status: request?.status };
        }
        return request;
      },
      async updateMany(query) {
        calls.push(["updateMany", query]);
        return { count: updateCount };
      },
    },
  };
  const handler = createCourtStudyMembershipContinuationHandler({
    prisma,
    verifyContinuationToken: (id, token) =>
      tokenIsValid && id === requestId && token === continuationToken,
    isActiveSubscriberEmail: async (email) => {
      calls.push(["isActiveSubscriberEmail", email]);
      return activeSubscriber;
    },
    sendApprovalEmail: async (emailData) => {
      calls.push(["sendApprovalEmail", emailData]);
    },
    logError: (...args) => calls.push(["logError", ...args]),
  });
  const response = createResponse();

  return {
    calls,
    response,
    run: (body) => handler(createRequest(body), response),
  };
}

const validBody = {
  requestId,
  token: continuationToken,
};

test("membership enrollment accepts eligible plans and carries continuation context", async () => {
  for (const plan of [
    "BASIC",
    "ORGANIZER",
    "CHURCH_INDIVIDUAL",
    "CHURCH_GROUP",
  ]) {
    const setup = createEnrollmentSetup();

    await setup.run({
      ...validBody,
      plan,
    });

    assert.equal(setup.response.statusCode, 200, plan);
    assert.deepEqual(setup.response.body, {
      success: true,
      status: "VERIFICATION_REQUIRED",
    });
    assert.equal(setup.response.headers["Cache-Control"], "no-store");
    assert.deepEqual(
      setup.calls.find(([name]) => name === "requestMembershipVerification"),
      [
        "requestMembershipVerification",
        "organizer@example.com",
        plan,
        { requestId, token: continuationToken },
      ]
    );
  }
});

test("membership enrollment rejects caller-supplied identity fields", async () => {
  const setup = createEnrollmentSetup();

  await setup.run({
    ...validBody,
    plan: "BASIC",
    email: "attacker@example.com",
  });

  assert.equal(setup.response.statusCode, 400);
  assert.equal(setup.calls.length, 0);
});

test("membership enrollment requires an explicitly selected eligible plan", async () => {
  const setup = createEnrollmentSetup();

  await setup.run(validBody);

  assert.equal(setup.response.statusCode, 400);
  assert.equal(setup.calls.length, 0);
});

test("membership enrollment rejects unsupported plan codes", async () => {
  const setup = createEnrollmentSetup();

  await setup.run({ ...validBody, plan: "UNSUPPORTED" });

  assert.equal(setup.response.statusCode, 400);
  assert.equal(setup.calls.length, 0);
});

test("membership enrollment rejects invalid continuation credentials", async () => {
  const setup = createEnrollmentSetup({ tokenIsValid: false });

  await setup.run({ ...validBody, plan: "ORGANIZER" });

  assert.equal(setup.response.statusCode, 403);
  assert.equal(setup.calls.length, 0);
});

test("membership enrollment returns active subscriber state without restarting checkout", async () => {
  for (const plan of [
    "BASIC",
    "ORGANIZER",
    "CHURCH_INDIVIDUAL",
    "CHURCH_GROUP",
  ]) {
    const setup = createEnrollmentSetup({ activeSubscriber: true });

    await setup.run({ ...validBody, plan });

    assert.equal(setup.response.statusCode, 200, plan);
    assert.deepEqual(setup.response.body, {
      success: true,
      status: "ACTIVE_SUBSCRIBER",
      requestId,
    });
    assert.equal(
      setup.calls.some(([name]) => name === "requestMembershipVerification"),
      false
    );
  }
});

test("membership enrollment does not report success when the existing flow cannot start", async () => {
  const setup = createEnrollmentSetup({ verificationStarted: false });

  await setup.run({ ...validBody, plan: "BASIC" });

  assert.equal(setup.response.statusCode, 409);
  assert.deepEqual(setup.response.body, {
    success: false,
    status: "MEMBERSHIP_ENROLLMENT_UNAVAILABLE",
    error: "Membership enrollment cannot be started for this request right now.",
  });
});

test("continuation approves a pending request only after active subscription verification", async () => {
  const setup = createContinuationSetup();

  await setup.run(validBody);

  assert.equal(setup.response.statusCode, 200);
  assert.deepEqual(setup.response.body, {
    success: true,
    requestId,
    status: "APPROVED",
    zoomReady: true,
  });
  assert.equal(setup.response.headers["Cache-Control"], "no-store");
  assert.deepEqual(
    setup.calls.find(([name]) => name === "isActiveSubscriberEmail"),
    ["isActiveSubscriberEmail", "organizer@example.com"]
  );
  assert.deepEqual(
    setup.calls.find(([name]) => name === "updateMany"),
    [
      "updateMany",
      {
        where: { id: requestId, status: "PENDING" },
        data: { status: "APPROVED" },
      },
    ]
  );
  assert.equal(
    setup.calls.filter(([name]) => name === "sendApprovalEmail").length,
    1
  );
});

test("continuation rejects a missing token before database access", async () => {
  const setup = createContinuationSetup();

  await setup.run({ requestId });

  assert.equal(setup.response.statusCode, 400);
  assert.equal(setup.calls.length, 0);
});

test("continuation rejects an invalid token before database access", async () => {
  const setup = createContinuationSetup({ tokenIsValid: false });

  await setup.run(validBody);

  assert.equal(setup.response.statusCode, 403);
  assert.equal(setup.calls.length, 0);
});

test("continuation cannot use one request token against another request", async () => {
  const setup = createContinuationSetup();

  await setup.run({
    requestId: "court-study-request-2",
    token: continuationToken,
  });

  assert.equal(setup.response.statusCode, 403);
  assert.equal(setup.calls.length, 0);
});

test("continuation leaves the request pending when the subscription is ineligible", async () => {
  const setup = createContinuationSetup({ activeSubscriber: false });

  await setup.run(validBody);

  assert.equal(setup.response.statusCode, 409);
  assert.deepEqual(setup.response.body, {
    success: false,
    requestId,
    status: "MEMBERSHIP_NOT_ACTIVE",
    zoomReady: false,
  });
  assert.equal(
    setup.calls.some(([name]) => name === "updateMany"),
    false
  );
  assert.equal(
    setup.calls.some(([name]) => name === "sendApprovalEmail"),
    false
  );
});

test("verification URL keeps continuation credentials in the fragment, not the query", () => {
  const verificationUrl = new URL(
    buildMembershipVerificationUrl(
      "https://www.courtofcompassion.com",
      "verification-token",
      { requestId, token: continuationToken }
    )
  );

  assert.deepEqual([...verificationUrl.searchParams.entries()], [
    ["token", "verification-token"],
  ]);
  assert.deepEqual(
    [...new URLSearchParams(verificationUrl.hash.slice(1)).entries()],
    [
      ["courtStudyRequestId", requestId],
      ["courtStudyToken", continuationToken],
    ]
  );
});
