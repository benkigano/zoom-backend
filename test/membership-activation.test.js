import test from "node:test";
import assert from "node:assert/strict";

import {
  sendMembershipActivationConfirmation,
  createMembershipCheckoutStatusHandler,
} from "../membership/activation.js";

const completedEnrollment = {
  email: "member@example.com",
  status: "COMPLETED",
  plan: "ORGANIZER",
  stripeSubscriptionId: "sub_123",
};

const activeSubscription = {
  status: "ACTIVE",
  plan: "ORGANIZER",
  stripeSubscriptionId: "sub_123",
};

function statusSetup(enrollment = completedEnrollment, subscription = activeSubscription) {
  const calls = [];
  const prisma = {
    membershipEnrollment: {
      findUnique: async (query) => {
        calls.push(["enrollment", query]);
        return enrollment;
      },
    },
    subscription: {
      findUnique: async (query) => {
        calls.push(["subscription", query]);
        return subscription;
      },
    },
  };
  const response = {
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return {
    calls,
    response,
    run: (sessionId) => createMembershipCheckoutStatusHandler(prisma)(
      { query: { session_id: sessionId } }, response
    ),
  };
}

test("status endpoint returns only ACTIVE for a matching completed enrollment", async () => {
  const setup = statusSetup();
  await setup.run("cs_test_123");
  assert.equal(setup.response.statusCode, 200);
  assert.deepEqual(setup.response.body, { status: "ACTIVE" });
  assert.equal(setup.response.headers["Cache-Control"], "no-store");
  assert.deepEqual(setup.calls[0][1].where, { checkoutSessionId: "cs_test_123" });
  assert.deepEqual(setup.calls[1][1].where, { email: completedEnrollment.email });
});

test("status endpoint recognizes all four matching membership plans", async () => {
  for (const plan of ["BASIC", "ORGANIZER", "CHURCH_INDIVIDUAL", "CHURCH_GROUP"]) {
    const setup = statusSetup(
      { ...completedEnrollment, plan },
      { ...activeSubscription, plan }
    );
    await setup.run("cs_test_123");
    assert.deepEqual(setup.response.body, { status: "ACTIVE" });
  }
});

test("status endpoint returns PENDING for unknown or incomplete enrollments", async () => {
  for (const enrollment of [
    null,
    { ...completedEnrollment, status: "CHECKOUT_PENDING" },
    { ...completedEnrollment, status: "CHECKOUT_RECONCILIATION_PENDING" },
    { ...completedEnrollment, plan: "UNKNOWN" },
    { ...completedEnrollment, stripeSubscriptionId: null },
    { ...completedEnrollment, stripeSubscriptionId: " " },
  ]) {
    const setup = statusSetup(enrollment);
    await setup.run("cs_test_123");
    assert.deepEqual(setup.response.body, { status: "PENDING" });
    assert.equal(setup.calls.length, 1);
  }
});

test("status endpoint returns PENDING for absent or mismatched subscriptions", async () => {
  for (const subscription of [
    null,
    { ...activeSubscription, status: "CANCELED" },
    { ...activeSubscription, status: "PAST_DUE" },
    { ...activeSubscription, plan: "BASIC" },
    { ...activeSubscription, stripeSubscriptionId: "sub_other" },
    { ...activeSubscription, stripeSubscriptionId: null },
  ]) {
    const setup = statusSetup(completedEnrollment, subscription);
    await setup.run("cs_test_123");
    assert.equal(setup.response.statusCode, 200);
    assert.deepEqual(setup.response.body, { status: "PENDING" });
  }
});

test("status endpoint rejects missing or malformed session parameters without a lookup", async () => {
  for (const sessionId of [undefined, "", " ", ["cs_test_123"], "x".repeat(256)]) {
    const setup = statusSetup();
    await setup.run(sessionId);
    assert.deepEqual(setup.response.body, { status: "PENDING" });
    assert.equal(setup.calls.length, 0);
  }
});

test("status endpoint surfaces database failure without exposing details", async () => {
  const setup = statusSetup();
  const errors = [];
  const handler = createMembershipCheckoutStatusHandler({
    membershipEnrollment: {
      findUnique: async () => { throw new Error("sensitive database detail"); },
    },
  }, (...args) => errors.push(args));
  await handler({ query: { session_id: "cs_test_123" } }, setup.response);
  assert.equal(setup.response.statusCode, 503);
  assert.deepEqual(setup.response.body, {
    error: "Membership checkout status is temporarily unavailable.",
  });
  assert.equal(errors.length, 1);
});

test("confirmation is sent only for the first successful activation", async () => {
  const sent = [];
  const send = async (...args) => sent.push(args);
  const first = {
    handled: true,
    alreadyCompleted: false,
    enrollmentId: "enrollment_123",
    email: completedEnrollment.email,
    plan: "ORGANIZER",
  };
  await sendMembershipActivationConfirmation(first, send);
  for (const result of [
    { handled: true, alreadyCompleted: true },
    { handled: false, reason: "PAYMENT_NOT_CONFIRMED" },
    { handled: true, deferred: true },
    null,
  ]) {
    await sendMembershipActivationConfirmation(result, send);
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], completedEnrollment.email);
  assert.match(sent[0][2], /Organizer \(public\)/);
});

test("confirmation names all supported plans", async () => {
  for (const [plan, name] of [
    ["BASIC", "Basic Membership"],
    ["ORGANIZER", "Organizer (public)"],
    ["CHURCH_INDIVIDUAL", "Church Individual"],
    ["CHURCH_GROUP", "Church Group"],
  ]) {
    const sent = [];
    await sendMembershipActivationConfirmation(
      { handled: true, alreadyCompleted: false, email: "member@example.com", plan },
      async (...args) => sent.push(args)
    );
    assert.equal(sent.length, 1);
    assert.ok(sent[0][2].includes(name));
  }
});

test("confirmation failures are logged and do not throw", async () => {
  const errors = [];
  await sendMembershipActivationConfirmation(
    {
      handled: true,
      alreadyCompleted: false,
      enrollmentId: "enrollment_123",
      email: "member@example.com",
      plan: "BASIC",
    },
    async () => { throw new Error("SMTP unavailable"); },
    (...args) => errors.push(args)
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1], "enrollment_123");
  assert.equal(errors[0][2], "SMTP unavailable");
});
