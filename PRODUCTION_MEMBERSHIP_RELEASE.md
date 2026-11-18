# Court of Compassion — Production Membership Integration (Prepared, not deployed)

Branch: `feature/production-membership-integration`, forked from production `main`.

## Scope

- Reuses tested Basic, Organizer (public), Church Individual, and Church Group enrollment/verification/Stripe Checkout flow.
- Includes signed Stripe webhook reconciliation and existing email-based active-subscription qualification.
- Keeps production Gmail SMTP; the staging Mailtrap/emulator-specific email transport changes were deliberately excluded.
- Preserves existing Court Study and Book Study routes and Zoom workflow.
- Does **not** add limits on Court Studies for active paid subscribers.
- Does **not** change the $19.95 one-time Court Study price or existing payment route.
- Does **not** implement Free enrollment or interview/focus-group allowance enforcement.
- Does **not** include `staging-prisma/` baseline files.

## Required verification before merge/deploy

1. **Schema and migration history:** Read-only inspect production `MembershipEnrollment` table and `_prisma_migrations` state. The proposed migration at `prisma/migrations/20261117132000_prepare_production_membership_enrollment/migration.sql` can create a missing table or add the required `checkoutAccessTokenHash` field, but must not be applied until existing schema, indexes, migration history, and duplicates are checked. **Do not reset/resolve migration history casually.** A database backup and approved migration plan are prerequisites.
2. **Stripe environment separation:** Confirm production `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and four recurring price IDs (`STRIPE_PRICE_BASIC`, `STRIPE_PRICE_ORGANIZER`, `STRIPE_PRICE_CHURCH_INDIVIDUAL`, `STRIPE_PRICE_CHURCH_GROUP`) all belong to the same intended Stripe mode/account. Do not send staging sandbox webhook events to production. Do not change or enable live payments before SPC authorization.
3. **Site origin:** Set `MEMBERSHIP_SITE_ORIGIN=https://www.courtofcompassion.com` for production. Verification links and Stripe Checkout success/cancel URLs are derived from this variable. It must be an HTTP(S) origin with no path.
4. **Email:** Confirm production Gmail SMTP credentials and verified sending address. Do not import staging-specific email-delivery mode.
5. **Code checks on a local checkout of this branch:** Run `npm install` (no lockfile is currently available), `node --check server.js`, `node --test test/membership-guards.test.js`, `npx prisma validate` and `npx prisma generate` using an appropriate placeholder DATABASE_URL for schema-only commands. No production DB access for code checks.
6. **Cutover review:** Confirm Wix's published `/subscribe`, `/membership/verify`, `/membership/success`, and `/membership/cancelled` routes are ready and consistent with backend response shapes. Wix publication publishes the whole site's pending changes.
7. **Actual user workflow:** After authorized production configuration, use the previously verified November 4 Zoom organizer account in the normal Court Study flow. Do not rely on fictitious example.com addresses for Zoom OAuth.
8. **Current policy:** Free users may create unlimited free Book Studies and pay $19.95 for each Court Study. Paid active subscribers may create unlimited Court Studies and unlimited free Book Studies. Membership plans are independent. Organizer solo interview 1/month; Church Individual solo interview 2/month plus focus-group 1/month; Church Group solo interview 4/month plus focus-group 4/month. Interview quotas are a separate implementation workstream.

## Release gates

No merge into main, Render deployment, production migration, Stripe live-mode activation, or Wix Publish is authorized by creating this branch. Review and explicit authorization are required at each release gate.
