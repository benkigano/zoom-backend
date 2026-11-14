\# Court of Compassion — Staging Prisma Baseline



\## Purpose



This directory provides an independent Prisma migration

history for the Court of Compassion membership staging

PostgreSQL database.



It must never be used to initialize or migrate production.



\## Source



Repository: benkigano/zoom-backend

Branch: feature/basic-membership-enrollment

Source revision: 8c8eb16d644d033aa0503e685f51f9dd778a91a5



The staging schema was copied from prisma/schema.prisma.



Baseline SQL was generated using Prisma CLI 6.19.3

with migrate diff --from-empty --to-schema-datamodel.



\## Membership constraint



The baseline includes the SQL-only partial unique index:



MembershipEnrollment\_one\_active\_per\_email\_plan



It permits only one nonterminal enrollment per email

and plan across these statuses:



\- PENDING\_VERIFICATION

\- EMAIL\_VERIFIED

\- CHECKOUT\_PENDING

\- CHECKOUT\_RECONCILIATION\_PENDING



The index definition was copied from the existing

MembershipEnrollment migration.



\## Separate migration histories



The original prisma/migrations directory is preserved.



The staging baseline is necessary because the checked-in

historical migrations cannot recreate an empty database

without encountering missing earlier table definitions.



Do not mix the staging and production migration histories.



Future schema changes must be reviewed against both

histories before preparing additional migrations.



The staging schema must remain aligned with the

application schema.



\## Database safety



Before any staging initialization:



1\. Verify the target is court-membership-staging-db.

2\. Confirm that it is separate from production.

3\. Confirm the intended database and schema are empty.

4\. Use staging-only database credentials.

5\. Review the complete generated baseline SQL.

6\. Validate all required SQL-only constraints.

7\. Obtain explicit authorization before database writes.



Never copy production customer data or credentials

into staging.



\## Deployment status



Baseline files prepared locally.



NO database initialization has been performed.

NO Prisma migrations have been executed.

NO Render staging deployment has been authorized.

NO production database changes have been made.



Stripe, email, frontend URLs, and webhooks require

separate staging-isolation checks before payment testing.



