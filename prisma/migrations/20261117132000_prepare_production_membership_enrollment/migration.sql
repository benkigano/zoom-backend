-- Court of Compassion: production membership enrollment compatibility
-- This migration is prepared only; do NOT apply until the production
-- database schema and Prisma migration history have been reviewed.
-- The Subscription table and existing user/study data are untouched.

CREATE TABLE IF NOT EXISTS "MembershipEnrollment" (
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
  CONSTRAINT "MembershipEnrollment_pkey" PRIMARY KEY ("id")
);

-- Existing production database installations may already have
-- MembershipEnrollment. Add only the new authorization field.
ALTER TABLE "MembershipEnrollment"
  ADD COLUMN IF NOT EXISTS "checkoutAccessTokenHash" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS
  "MembershipEnrollment_verificationTokenHash_key"
  ON "MembershipEnrollment"("verificationTokenHash");
CREATE UNIQUE INDEX IF NOT EXISTS
  "MembershipEnrollment_checkoutAccessTokenHash_key"
  ON "MembershipEnrollment"("checkoutAccessTokenHash");
CREATE UNIQUE INDEX IF NOT EXISTS
  "MembershipEnrollment_checkoutAttemptKey_key"
  ON "MembershipEnrollment"("checkoutAttemptKey");
CREATE UNIQUE INDEX IF NOT EXISTS
  "MembershipEnrollment_checkoutSessionId_key"
  ON "MembershipEnrollment"("checkoutSessionId");
CREATE UNIQUE INDEX IF NOT EXISTS
  "MembershipEnrollment_stripeSubscriptionId_key"
  ON "MembershipEnrollment"("stripeSubscriptionId");

CREATE INDEX IF NOT EXISTS
  "MembershipEnrollment_email_status_idx"
  ON "MembershipEnrollment"("email", "status");
CREATE INDEX IF NOT EXISTS
  "MembershipEnrollment_checkoutExpiresAt_idx"
  ON "MembershipEnrollment"("checkoutExpiresAt");
CREATE INDEX IF NOT EXISTS
  "MembershipEnrollment_createdAt_idx"
  ON "MembershipEnrollment"("createdAt");

-- Retain a single nonterminal enrollment for a given email/plan.
-- This partial index is intentionally SQL-only (not Prisma schema syntax).
CREATE UNIQUE INDEX IF NOT EXISTS
  "MembershipEnrollment_one_active_per_email_plan"
  ON "MembershipEnrollment"("email", "plan")
  WHERE "status" IN (
    'PENDING_VERIFICATION',
    'EMAIL_VERIFIED',
    'CHECKOUT_PENDING',
    'CHECKOUT_RECONCILIATION_PENDING'
  );
