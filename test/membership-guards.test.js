
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeMembershipEmail,
  normalizeMembershipPlan,
  getMembershipPlanName,
  getMembershipPriceId,
  getMembershipPlanFromPriceId,
  validateMembershipSubscriptionMetadata,
  isMembershipCheckoutEligible,
  isBasicMembershipCheckoutEligible,
} from "../membership/guards.js";
import { claimMembershipCheckout } from "../membership/checkout.js";

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

const PLAN_PRICES = {
  BASIC: ["STRIPE_PRICE_BASIC", "price_basic"],
  ORGANIZER: ["STRIPE_PRICE_ORGANIZER", "price_organizer"],
  CHURCH_INDIVIDUAL: ["STRIPE_PRICE_CHURCH_INDIVIDUAL", "price_church_individual"],
  CHURCH_GROUP: ["STRIPE_PRICE_CHURCH_GROUP", "price_church_group"],
};

const PRICE_ENV = Object.fromEntries(Object.values(PLAN_PRICES));

test("enrollment defaults to Basic and validates plan codes", () => {
  assert.equal(normalizeMembershipPlan(undefined), "BASIC");
  for (const plan of Object.keys(PLAN_PRICES)) {
    assert.equal(normalizeMembershipPlan(` ${plan.toLowerCase()} `), plan);
  }
  for (const invalid of ["", "FREE", "CHURCH", "constructor", null, 123, {}]) {
    assert.equal(normalizeMembershipPlan(invalid), null);
  }
  assert.equal(getMembershipPlanName("ORGANIZER"), "Organizer (public)");
});

for (const [plan, [envName, priceId]] of Object.entries(PLAN_PRICES)) {
  test(`${plan} uses its server-side price and is eligible for checkout`, () => {
    assert.equal(getMembershipPriceId(plan, PRICE_ENV), priceId);
    assert.equal(getMembershipPlanFromPriceId(` ${priceId} `, PRICE_ENV), plan);
    assert.equal(getMembershipPriceId(plan, { [envName]: "  " }), "");
    assert.equal(
      isMembershipCheckoutEligible(eligibleEnrollment({ plan }), TEST_NOW),
      true
    );
    assert.equal(
      isMembershipCheckoutEligible(
        eligibleEnrollment({ plan, checkoutExpiresAt: new Date(TEST_NOW) }),
        TEST_NOW
      ),
      false
    );
  });

  test(`${plan} reconciliation requires matching plan, enrollment and price`, () => {
    const metadata = {
      paymentPurpose: "GENERAL_MEMBERSHIP_SUBSCRIPTION",
      subscriptionPlan: plan,
      membershipEnrollmentId: "enrollment-1",
    };
    assert.equal(
      validateMembershipSubscriptionMetadata(metadata, { ...metadata }, priceId, PRICE_ENV),
      plan
    );
    assert.throws(() =>
      validateMembershipSubscriptionMetadata(metadata, { ...metadata }, "wrong-price", PRICE_ENV)
    );
    assert.throws(() =>
      validateMembershipSubscriptionMetadata(metadata, { ...metadata }, priceId, {})
    );
    assert.throws(() =>
      validateMembershipSubscriptionMetadata(
        metadata, { ...metadata, subscriptionPlan: "INVALID" }, priceId, PRICE_ENV
      )
    );
    assert.throws(() =>
      validateMembershipSubscriptionMetadata(
        metadata, { ...metadata, membershipEnrollmentId: "another-enrollment" }, priceId, PRICE_ENV
      )
    );
    assert.throws(() =>
      validateMembershipSubscriptionMetadata(
        metadata, { ...metadata, paymentPurpose: "OTHER" }, priceId, PRICE_ENV
      )
    );
  });
}

test("duplicate configured prices fail closed", () => {
  const env = { ...PRICE_ENV, STRIPE_PRICE_ORGANIZER: PRICE_ENV.STRIPE_PRICE_BASIC };
  assert.throws(() => getMembershipPriceId("BASIC", env));
  assert.throws(() => getMembershipPriceId("ORGANIZER", env));
  assert.equal(getMembershipPlanFromPriceId(PRICE_ENV.STRIPE_PRICE_BASIC, env), null);
});

test("unknown plans cannot select a price or pass checkout and reconciliation", () => {
  assert.equal(getMembershipPriceId("constructor", PRICE_ENV), "");
  assert.equal(isMembershipCheckoutEligible(eligibleEnrollment({ plan: "FREE" }), TEST_NOW), false);
  assert.throws(() =>
    validateMembershipSubscriptionMetadata(
      { paymentPurpose: "GENERAL_MEMBERSHIP_SUBSCRIPTION", subscriptionPlan: "FREE", membershipEnrollmentId: "e" },
      { paymentPurpose: "GENERAL_MEMBERSHIP_SUBSCRIPTION", subscriptionPlan: "FREE", membershipEnrollmentId: "e" },
      "price_basic",
      PRICE_ENV
    )
  );
});

function checkoutTransaction({ otherCheckout = null, subscription = null, count = 1 } = {}) {
  const calls = [];
  const tx = {
    $queryRaw: async (strings, email) => {
      calls.push(["lock", email]);
    },
    membershipEnrollment: {
      findFirst: async (query) => {
        calls.push(["findCheckout", query]);
        return otherCheckout;
      },
      updateMany: async (query) => {
        calls.push(["claim", query]);
        return { count };
      },
    },
    subscription: {
      findUnique: async (query) => {
        calls.push(["findSubscription", query]);
        return subscription;
      },
    },
  };
  return {
    calls,
    prisma: {
      $transaction: async (callback, options) => {
        assert.equal(options.isolationLevel, "ReadCommitted");
        return callback(tx);
      },
    },
  };
}

test("checkout claims serialize by email and guard other plans and existing subscriptions", async () => {
  const enrollment = { id: "enrollment-1", email: "member@example.com" };
  const setup = checkoutTransaction();
  assert.equal(await claimMembershipCheckout(setup.prisma, enrollment, "hash", "attempt"), "CLAIMED");
  assert.deepEqual(setup.calls.map(([name]) => name), ["lock", "findCheckout", "findSubscription", "claim"]);
  assert.equal(setup.calls[0][1], enrollment.email);
  assert.equal(setup.calls[1][1].where.id.not, enrollment.id);
  assert.deepEqual(setup.calls[1][1].where.status.in, ["CHECKOUT_PENDING", "CHECKOUT_RECONCILIATION_PENDING"]);
  assert.equal(setup.calls[3][1].where.checkoutAccessTokenHash, "hash");
  assert.equal(setup.calls[3][1].data.checkoutAttemptKey, "attempt");

  const pending = checkoutTransaction({ otherCheckout: { id: "other-plan" } });
  assert.equal(await claimMembershipCheckout(pending.prisma, enrollment, "hash", "attempt"), "OTHER_CHECKOUT");
  assert.equal(pending.calls.some(([name]) => name === "claim"), false);

  const existing = checkoutTransaction({ subscription: { id: "subscription" } });
  assert.equal(await claimMembershipCheckout(existing.prisma, enrollment, "hash", "attempt"), "EXISTING_SUBSCRIPTION");
  assert.equal(existing.calls.some(([name]) => name === "claim"), false);

  const conflict = checkoutTransaction({ count: 0 });
  assert.equal(await claimMembershipCheckout(conflict.prisma, enrollment, "hash", "attempt"), "CONFLICT");
});

test("checkout claim surfaces transaction failures", async () => {
  const prisma = {
    $transaction: async () => { throw new Error("database unavailable"); },
  };
  await assert.rejects(
    claimMembershipCheckout(prisma, { id: "e", email: "member@example.com" }, "hash", "attempt"),
    /database unavailable/
  );
});
