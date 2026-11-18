// Court of Compassion general membership webhook routing.
// This protects the membership workflow; legacy Court Study events are unchanged.
const GENERAL_MEMBERSHIP_PURPOSE = "GENERAL_MEMBERSHIP_SUBSCRIPTION";
const MEMBERSHIP_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

function getMembershipDeploymentEnvironment(env = process.env) {
  const value = String(env?.MEMBERSHIP_DEPLOYMENT_ENV || "").trim();
  return value === "staging" || value === "production" ? value : null;
}

// An event must be signature-verified before this function is called.
// Foreign or untagged general memberships are acknowledged but not processed.
function membershipWebhookRouting(event, env = process.env) {
  if (!MEMBERSHIP_EVENTS.has(event?.type)) {
    return { membership: false, accept: true, reason: "OTHER_EVENT" };
  }
  const metadata = event?.data?.object?.metadata || {};
  if (metadata.paymentPurpose !== GENERAL_MEMBERSHIP_PURPOSE) {
    return { membership: false, accept: true, reason: "OTHER_PURPOSE" };
  }
  const runtime = getMembershipDeploymentEnvironment(env);
  if (!runtime) {
    return { membership: true, accept: false, reason: "ENVIRONMENT_UNCONFIGURED" };
  }
  if (metadata.membershipEnvironment !== runtime) {
    return { membership: true, accept: false, reason: "ENVIRONMENT_MISMATCH" };
  }
  return { membership: true, accept: true, reason: "ENVIRONMENT_MATCH" };
}

function requireMembershipEnvironment(metadata, env = process.env) {
  const runtime = getMembershipDeploymentEnvironment(env);
  if (!runtime) {
    throw new Error("MEMBERSHIP_DEPLOYMENT_ENV must be staging or production");
  }
  if (metadata?.membershipEnvironment !== runtime) {
    throw new Error("General membership environment mismatch");
  }
  return runtime;
}

export {
  getMembershipDeploymentEnvironment,
  membershipWebhookRouting,
  requireMembershipEnvironment,
};
