import { getMembershipPlanName, isMembershipPlan } from "./guards.js";

async function sendMembershipActivationConfirmation(
  result,
  sendEmail,
  logError = console.error
) {
  if (result?.handled !== true || result.alreadyCompleted !== false) {
    return;
  }

  try {
    const planName = getMembershipPlanName(result.plan);
    if (!planName || !result.email) {
      throw new Error("Missing membership confirmation details");
    }

    await sendEmail(
      result.email,
      "Your Court of Compassion membership is active",
      [
        "Your Court of Compassion membership is now active.",
        "",
        `Membership plan: ${planName}`,
        "",
        "Thank you for joining Court of Compassion.",
      ].join("\n")
    );
  } catch (error) {
    logError(
      "Membership activation confirmation failed:",
      result.enrollmentId,
      error?.code || error?.message || "Unknown error"
    );
  }
}

function createMembershipCheckoutStatusHandler(prisma, logError = console.error) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");

    const sessionId = typeof req.query?.session_id === "string"
      ? req.query.session_id.trim()
      : "";

    if (!sessionId || sessionId.length > 255) {
      return res.status(200).json({ status: "PENDING" });
    }

    try {
      const enrollment = await prisma.membershipEnrollment.findUnique({
        where: { checkoutSessionId: sessionId },
        select: {
          email: true,
          status: true,
          plan: true,
          stripeSubscriptionId: true,
        },
      });

      if (
        !enrollment ||
        enrollment.status !== "COMPLETED" ||
        !isMembershipPlan(enrollment.plan) ||
        typeof enrollment.email !== "string" ||
        !enrollment.email.trim() ||
        typeof enrollment.stripeSubscriptionId !== "string" ||
        !enrollment.stripeSubscriptionId.trim()
      ) {
        return res.status(200).json({ status: "PENDING" });
      }

      const subscription = await prisma.subscription.findUnique({
        where: { email: enrollment.email },
        select: { status: true, plan: true, stripeSubscriptionId: true },
      });

      const active =
        subscription?.status === "ACTIVE" &&
        subscription.plan === enrollment.plan &&
        subscription.stripeSubscriptionId === enrollment.stripeSubscriptionId;

      return res.status(200).json({ status: active ? "ACTIVE" : "PENDING" });
    } catch (error) {
      logError(
        "Membership checkout status lookup failed:",
        error?.code || error?.message || "Unknown error"
      );
      return res.status(503).json({
        error: "Membership checkout status is temporarily unavailable.",
      });
    }
  };
}

export {
  sendMembershipActivationConfirmation,
  createMembershipCheckoutStatusHandler,
};
