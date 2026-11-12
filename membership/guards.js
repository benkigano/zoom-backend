
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

export { normalizeMembershipEmail };
