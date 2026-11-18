import test from "node:test";
import assert from "node:assert/strict";
import { shouldIgnoreGeneralMembershipEvent } from "../webhooks/generalMembershipQuarantine.js";

const makeEvent = (type, metadata) => ({
  type,
  data: { object: { metadata } },
});
const general = { paymentPurpose: "GENERAL_MEMBERSHIP_SUBSCRIPTION" };

test("ignores general membership checkout before legacy reconciliation", () => {
  assert.equal(
    shouldIgnoreGeneralMembershipEvent(makeEvent("checkout.session.completed", general)),
    true
  );
});

test("ignores general membership subscription create, update, and delete", () => {
  for (const type of [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ]) {
    assert.equal(shouldIgnoreGeneralMembershipEvent(makeEvent(type, general)), true);
  }
});

test("ignores partially tagged general memberships with enrollment ID", () => {
  assert.equal(
    shouldIgnoreGeneralMembershipEvent(
      makeEvent("customer.subscription.updated", { membershipEnrollmentId: "enroll_123" })
    ),
    true
  );
});

test("preserves existing Court Study one-time payments", () => {
  const event = makeEvent("checkout.session.completed", {
    paymentPurpose: "COURT_STUDY_NON_SUBSCRIBER",
    courtStudyRequestId: "request_123",
  });
  assert.equal(shouldIgnoreGeneralMembershipEvent(event), false);
});

test("preserves existing Court Study subscription checkout", () => {
  const event = makeEvent("checkout.session.completed", {
    paymentPurpose: "COURT_STUDY_SUBSCRIPTION",
    courtStudyRequestId: "request_123",
  });
  assert.equal(shouldIgnoreGeneralMembershipEvent(event), false);
});

test("preserves existing Court Study subscription lifecycle events", () => {
  for (const type of [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ]) {
    assert.equal(
      shouldIgnoreGeneralMembershipEvent(
        makeEvent(type, { paymentPurpose: "COURT_STUDY_SUBSCRIPTION" })
      ),
      false
    );
  }
});

test("does not reject untagged legacy subscriptions", () => {
  assert.equal(
    shouldIgnoreGeneralMembershipEvent(makeEvent("customer.subscription.updated", {})),
    false
  );
  assert.equal(
    shouldIgnoreGeneralMembershipEvent(makeEvent("customer.subscription.updated", undefined)),
    false
  );
});

test("does not mistake unrelated Stripe events for general memberships", () => {
  assert.equal(shouldIgnoreGeneralMembershipEvent(makeEvent("invoice.paid", general)), false);
  assert.equal(shouldIgnoreGeneralMembershipEvent(makeEvent("payment_intent.succeeded", general)), false);
});

test("handles malformed event objects without intercepting legacy processing", () => {
  for (const value of [undefined, null, {}, { type: "checkout.session.completed" }]) {
    assert.equal(shouldIgnoreGeneralMembershipEvent(value), false);
  }
});

test("blank enrollment IDs alone do not trigger quarantine", () => {
  assert.equal(
    shouldIgnoreGeneralMembershipEvent(
      makeEvent("customer.subscription.updated", { membershipEnrollmentId: "  " })
    ),
    false
  );
});
