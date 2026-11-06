-- Court of Compassion
-- Membership Enrollment Migration
-- Creates a new enrollment table.
-- Does not modify the existing Subscription table.

CREATE TABLE "MembershipEnrollment" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'BASIC',
    "status" TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',

    "verificationTokenHash" TEXT,
    "verificationExpiresAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),

    "checkoutAccessTokenHash" TEXT,
    "checkoutAttemptKey" TEXT,
    "checkoutSessionId" TEXT,
    "checkoutExpiresAt" TIMESTAMP(3),

    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MembershipEnrollment_pkey"
        PRIMARY KEY ("id")
);

-- Unique identifiers for verification and checkout.

CREATE UNIQUE INDEX
    "MembershipEnrollment_verificationTokenHash_key"
ON "MembershipEnrollment"("verificationTokenHash");

CREATE UNIQUE INDEX
    "MembershipEnrollment_checkoutAccessTokenHash_key"
ON "MembershipEnrollment"("checkoutAccessTokenHash");

CREATE UNIQUE INDEX
    "MembershipEnrollment_checkoutAttemptKey_key"
ON "MembershipEnrollment"("checkoutAttemptKey");

CREATE UNIQUE INDEX
    "MembershipEnrollment_checkoutSessionId_key"
ON "MembershipEnrollment"("checkoutSessionId");

CREATE UNIQUE INDEX
    "MembershipEnrollment_stripeSubscriptionId_key"
ON "MembershipEnrollment"("stripeSubscriptionId");

-- Standard Prisma indexes.

CREATE INDEX
    "MembershipEnrollment_email_status_idx"
ON "MembershipEnrollment"("email", "status");

CREATE INDEX
    "MembershipEnrollment_checkoutExpiresAt_idx"
ON "MembershipEnrollment"("checkoutExpiresAt");

CREATE INDEX
    "MembershipEnrollment_createdAt_idx"
ON "MembershipEnrollment"("createdAt");

-- Only one nonterminal enrollment per email and plan.
-- Email normalization and valid status transitions
-- must also be enforced by the application.

CREATE UNIQUE INDEX
    "MembershipEnrollment_one_active_per_email_plan"
ON "MembershipEnrollment"("email", "plan")
WHERE "status" IN (
    'PENDING_VERIFICATION',
    'EMAIL_VERIFIED',
    'CHECKOUT_PENDING',
    'CHECKOUT_RECONCILIATION_PENDING'
);
