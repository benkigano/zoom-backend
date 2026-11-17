async function claimMembershipCheckout(prisma, enrollment, accessTokenHash, attemptKey) {
  return prisma.$transaction(async (tx) => {
    // Serialize checkout claims for an email across all plan enrollments.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${enrollment.email}, 0))::text`;

    const otherCheckout = await tx.membershipEnrollment.findFirst({
      where: {
        email: enrollment.email,
        id: { not: enrollment.id },
        status: { in: ["CHECKOUT_PENDING", "CHECKOUT_RECONCILIATION_PENDING"] },
      },
      select: { id: true },
    });

    if (otherCheckout) {
      return "OTHER_CHECKOUT";
    }

    // Check after the pending enrollment: reconciliation commits both
    // completion and the subscription record in a single transaction.
    const existing = await tx.subscription.findUnique({
      where: { email: enrollment.email },
      select: { id: true },
    });

    if (existing) {
      return "EXISTING_SUBSCRIPTION";
    }

    const claimed = await tx.membershipEnrollment.updateMany({
      where: {
        id: enrollment.id,
        status: "EMAIL_VERIFIED",
        checkoutAccessTokenHash: accessTokenHash,
        checkoutExpiresAt: { gt: new Date() },
        checkoutAttemptKey: null,
        checkoutSessionId: null,
      },
      data: {
        status: "CHECKOUT_PENDING",
        checkoutAttemptKey: attemptKey,
      },
    });

    return claimed.count === 1 ? "CLAIMED" : "CONFLICT";
  }, { isolationLevel: "ReadCommitted" });
}

export { claimMembershipCheckout };
