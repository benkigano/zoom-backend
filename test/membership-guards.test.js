
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeMembershipEmail,
  isBasicMembershipCheckoutEligible,
} from "../membership/guards.js";

test("normalizes email case and whitespace", () => {
  assert.equal(
    normalizeMembershipEmail(" Applicant@Example.com "),
    "applicant@example.com"
  );
});

test("preserves a valid normalized email", () => {
  assert.equal(
    normalizeMembershipEmail("member@example.com"),
    "member@example.com"
  );
});

test("rejects invalid email addresses", () => {
  for (const value of [
    "",
    "not-an-email",
    "missing@domain",
    "@example.com",
    "member example@example.com",
  ]) {
    assert.equal(normalizeMembershipEmail(value), null);
  }
});

test("rejects email addresses longer than 254 characters", () => {
  const email = "a".repeat(243) + "@example.com";

  assert.equal(normalizeMembershipEmail(email), null);
});

test("rejects missing email input", () => {
  assert.equal(normalizeMembershipEmail(null), null);
  assert.equal(normalizeMembershipEmail(undefined), null);
});


//
// BASIC MEMBERSHIP CHECKOUT ELIGIBILITY TESTS
// No Stripe or database connections are required.
//

const TEST_NOW = Date.parse("2026-11-12T20:00:00Z");

function eligibleEnrollment(overrides = {}) {
  return {
    plan: "BASIC",
    status: "EMAIL_VERIFIED",
    verifiedAt: new Date(TEST_NOW - 60000),
    checkoutExpiresAt: new Date(TEST_NOW + 900000),
    ...overrides,
  };
}

test("allows verified Basic Membership checkout", () => {
  assert.equal(
    isBasicMembershipCheckoutEligible(
      eligibleEnrollment(),
      TEST_NOW
    ),
    true
  );
});

test("allows eligible pending checkout resumption", () => {
  assert.equal(
    isBasicMembershipCheckoutEligible(
      eligibleEnrollment({
        status: "CHECKOUT_PENDING",
      }),
      TEST_NOW
    ),
    true
  );
});

test("rejects enrollment without email verification", () => {
  assert.equal(
    isBasicMembershipCheckoutEligible(
      eligibleEnrollment({
        verifiedAt: null,
      }),
      TEST_NOW
    ),
    false
  );
});

test("rejects enrollment with a different plan", () => {
  assert.equal(
    isBasicMembershipCheckoutEligible(
      eligibleEnrollment({
        plan: "ORGANIZER",
      }),
      TEST_NOW
    ),
    false
  );
});

test("rejects ineligible enrollment statuses", () => {
  for (const status of [
    "PENDING_VERIFICATION",
    "CHECKOUT_RECONCILIATION_PENDING",
    "COMPLETED",
    "CANCELLED",
  ]) {
    assert.equal(
      isBasicMembershipCheckoutEligible(
        eligibleEnrollment({ status }),
        TEST_NOW
      ),
      false
    );
  }
});

test("rejects expired checkout authorization", () => {
  for (const expiresAt of [
    new Date(TEST_NOW - 1000),
    new Date(TEST_NOW),
  ]) {
    assert.equal(
      isBasicMembershipCheckoutEligible(
        eligibleEnrollment({
          checkoutExpiresAt: expiresAt,
        }),
        TEST_NOW
      ),
      false
    );
  }
});

test("rejects invalid checkout expiration dates", () => {
  for (const expiresAt of [
    null,
    "invalid",
    new Date("invalid"),
  ]) {
    assert.equal(
      isBasicMembershipCheckoutEligible(
        eligibleEnrollment({
          checkoutExpiresAt: expiresAt,
        }),
        TEST_NOW
      ),
      false
    );
  }
});

test("rejects missing enrollment records", () => {
  assert.equal(
    isBasicMembershipCheckoutEligible(
      null,
      TEST_NOW
    ),
    false
  );
});
