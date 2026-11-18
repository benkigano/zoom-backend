// Protect the legacy production Stripe webhook until general membership
// enrollment and its database migration are explicitly released.
// This check runs only AFTER Stripe signature verification.
const LEGACY_WEBHOOK_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

export function shouldIgnoreGeneralMembershipEvent(event) {
  if (!LEGACY_WEBHOOK_EVENT_TYPES.has(event?.type)) {
    return false;
  }

  const metadata = event?.data?.object?.metadata;
  if (!metadata || typeof metadata !== "object") {
    return false;
  }

  // New and earlier staging enrollment checkouts carry the purpose marker.
  if (metadata.paymentPurpose === "GENERAL_MEMBERSHIP_SUBSCRIPTION") {
    return true;
  }

  // Also reject partially tagged membership events so the legacy
  // syncStripeSubscription function never treats them as Court Study subscriptions.
  return (
    typeof metadata.membershipEnrollmentId === "string" &&
    metadata.membershipEnrollmentId.trim().length > 0
  );
}
