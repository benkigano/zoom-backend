
/**
 * Normalize and validate a Basic Membership email address.
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


/**
 * Check whether a Basic Membership enrollment is
 * eligible to begin or resume Stripe Checkout.
 *
 * This function does not validate the checkout token.
 * Token authentication remains in the API endpoint.
 */
function isBasicMembershipCheckoutEligible(
  enrollment,
  now = Date.now()
) {
  if (
    !enrollment ||
    enrollment.plan !== "BASIC" ||
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


export {
  normalizeMembershipEmail,
  isBasicMembershipCheckoutEligible,
};
