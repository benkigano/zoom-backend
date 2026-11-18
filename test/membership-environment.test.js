import test from "node:test";
import assert from "node:assert/strict";
import {
  getMembershipDeploymentEnvironment,
  membershipWebhookRouting,
  requireMembershipEnvironment,
} from "../membership/environment.js";

const staging = { MEMBERSHIP_DEPLOYMENT_ENV: "staging" };
const production = { MEMBERSHIP_DEPLOYMENT_ENV: "production" };
const event = (type, paymentPurpose, membershipEnvironment) => ({
  type,
  data: { object: { metadata: { paymentPurpose, membershipEnvironment } } },
});
const purpose = "GENERAL_MEMBERSHIP_SUBSCRIPTION";

test("accepts only explicit staging or production membership configuration", () => {
  assert.equal(getMembershipDeploymentEnvironment(staging), "staging");
  assert.equal(getMembershipDeploymentEnvironment(production), "production");
  for (const value of ["", "test", "live", "PRODUCTION", "staging-extra"]) {
    assert.equal(getMembershipDeploymentEnvironment({ MEMBERSHIP_DEPLOYMENT_ENV: value }), null);
  }
});

test("a matching staging membership Checkout event is accepted", () => {
  assert.deepEqual(
    membershipWebhookRouting(event("checkout.session.completed", purpose, "staging"), staging),
    { membership: true, accept: true, reason: "ENVIRONMENT_MATCH" }
  );
});

test("a matching production membership subscription lifecycle event is accepted", () => {
  for (const type of [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ]) {
    assert.equal(
      membershipWebhookRouting(event(type, purpose, "production"), production).accept,
      true
    );
  }
});

test("staging membership events do not reach production reconciliation", () => {
  for (const type of [
    "checkout.session.completed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ]) {
    const decision = membershipWebhookRouting(event(type, purpose, "staging"), production);
    assert.equal(decision.membership, true);
    assert.equal(decision.accept, false);
    assert.equal(decision.reason, "ENVIRONMENT_MISMATCH");
  }
});

test("production membership events do not reach staging reconciliation", () => {
  const decision = membershipWebhookRouting(event("checkout.session.completed", purpose, "production"), staging);
  assert.equal(decision.accept, false);
});

test("missing origin and missing runtime configuration fail closed", () => {
  const unmarked = event("checkout.session.completed", purpose, undefined);
  assert.equal(membershipWebhookRouting(unmarked, production).accept, false);
  const noConfig = membershipWebhookRouting(event("checkout.session.completed", purpose, "staging"), {});
  assert.equal(noConfig.accept, false);
  assert.equal(noConfig.reason, "ENVIRONMENT_UNCONFIGURED");
});

test("existing Court Study checkout is not intercepted", () => {
  const courtStudy = event("checkout.session.completed", "COURT_STUDY_NON_SUBSCRIBER", undefined);
  assert.equal(membershipWebhookRouting(courtStudy, production).membership, false);
  assert.equal(membershipWebhookRouting(courtStudy, {}).accept, true);
});

test("existing Court Study subscriptions and unrelated events are unchanged", () => {
  const courtStudy = event("customer.subscription.updated", "COURT_STUDY_SUBSCRIPTION", undefined);
  const other = event("invoice.paid", purpose, "staging");
  assert.equal(membershipWebhookRouting(courtStudy, production).accept, true);
  assert.equal(membershipWebhookRouting(other, production).membership, false);
});

test("deeper reconciliation guard rejects mismatched and unmarked metadata", () => {
  assert.equal(requireMembershipEnvironment({ membershipEnvironment: "staging" }, staging), "staging");
  assert.throws(() => requireMembershipEnvironment({ membershipEnvironment: "staging" }, production));
  assert.throws(() => requireMembershipEnvironment({}, production));
  assert.throws(() => requireMembershipEnvironment({ membershipEnvironment: "staging" }, {}));
});
