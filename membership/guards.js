
/**
 * Normalize and validate a membership email address.
 * This module has no Stripe, database, or network dependencies.
 */
function normalizeMembershipEmail(value) {
  const email = String(value || "").trim().toLowerCase();

  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return null;
  }

  return email;
}


const MEMBERSHIP_PLANS = {
  BASIC: { name: "Basic Membership", priceEnv: "STRIPE_PRICE_BASIC" },
  ORGANIZER: { name: "Organizer (public)", priceEnv: "STRIPE_PRICE_ORGANIZER" },
  CHURCH_INDIVIDUAL: { name: "Church Individual", priceEnv: "STRIPE_PRICE_CHURCH_INDIVIDUAL" },
  CHURCH_GROUP: { name: "Church Group", priceEnv: "STRIPE_PRICE_CHURCH_GROUP" },
};

function isMembershipPlan(plan) {
  return typeof plan === "string" &&
    Object.prototype.hasOwnProperty.call(MEMBERSHIP_PLANS, plan);
}

function normalizeMembershipPlan(value) {
  if (value === undefined) {
    return "BASIC";
  }

  if (typeof value !== "string") {
    return null;
  }

  const plan = value.trim().toUpperCase();
  return isMembershipPlan(plan) ? plan : null;
}

function getMembershipPlanName(plan) {
  return isMembershipPlan(plan) ? MEMBERSHIP_PLANS[plan].name : null;
}

function getMembershipPriceId(plan, env = process.env) {
  if (!isMembershipPlan(plan)) {
    return "";
  }

  const priceId = String(env[MEMBERSHIP_PLANS[plan].priceEnv] || "").trim();
  if (
    priceId &&
    Object.keys(MEMBERSHIP_PLANS).some((otherPlan) =>
      otherPlan !== plan &&
      String(env[MEMBERSHIP_PLANS[otherPlan].priceEnv] || "").trim() === priceId
    )
  ) {
    throw new Error("Membership Stripe prices must be distinct");
  }

  return priceId;
}

function getMembershipPlanFromPriceId(priceId, env = process.env) {
  const normalizedPriceId = String(priceId || "").trim();
  if (!normalizedPriceId) {
    return null;
  }

  const matches = Object.keys(MEMBERSHIP_PLANS).filter((plan) =>
    String(env[MEMBERSHIP_PLANS[plan].priceEnv] || "").trim() === normalizedPriceId
  );
  return matches.length === 1 ? matches[0] : null;
}

function validateMembershipSubscriptionMetadata(
  sessionMetadata,
  subscriptionMetadata,
  stripePriceId,
  env = process.env
) {
  const plan = sessionMetadata?.subscriptionPlan;
  const enrollmentId = sessionMetadata?.membershipEnrollmentId;

  if (
    sessionMetadata?.paymentPurpose !== "GENERAL_MEMBERSHIP_SUBSCRIPTION" ||
    !isMembershipPlan(plan) ||
    typeof enrollmentId !== "string" ||
    !enrollmentId.trim() ||
    subscriptionMetadata?.paymentPurpose !== "GENERAL_MEMBERSHIP_SUBSCRIPTION" ||
    subscriptionMetadata?.subscriptionPlan !== plan ||
    subscriptionMetadata?.membershipEnrollmentId !== enrollmentId
  ) {
    throw new Error("Stripe subscription metadata mismatch");
  }

  const expectedPriceId = getMembershipPriceId(plan, env);
  if (!expectedPriceId || stripePriceId !== expectedPriceId) {
    throw new Error("Membership Stripe price mismatch");
  }

  return plan;
}

// Token authentication remains in the API endpoint.
function isMembershipCheckoutEligible(
  enrollment,
  now = Date.now()
) {
  if (
    !enrollment ||
    !isMembershipPlan(enrollment.plan) ||
    !enrollment.verifiedAt ||
    ![
      "EMAIL_VERIFIED",
      "CHECKOUT_PENDING",
    ].includes(enrollment.status)
  ) {
    return false;
  }

  const expiresAt = enrollment.checkoutExpiresAt;

  if (
    !(expiresAt instanceof Date) ||
    !Number.isFinite(expiresAt.getTime())
  ) {
    return false;
  }

  return expiresAt.getTime() > now;
}

function isBasicMembershipCheckoutEligible(enrollment, now = Date.now()) {
  return enrollment?.plan === "BASIC" &&
    isMembershipCheckoutEligible(enrollment, now);
}

export {
  normalizeMembershipEmail,
  normalizeMembershipPlan,
  isMembershipPlan,
  getMembershipPlanName,
  getMembershipPriceId,
  getMembershipPlanFromPriceId,
  validateMembershipSubscriptionMetadata,
  isMembershipCheckoutEligible,
  isBasicMembershipCheckoutEligible,
};
