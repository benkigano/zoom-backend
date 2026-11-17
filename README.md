# zoom-backend
Backend for Zoom + Wix integration

## Paid membership enrollment

`POST /api/membership/enroll` accepts an email and an optional `plan`
(`BASIC`, `ORGANIZER`, `CHURCH_INDIVIDUAL`, or `CHURCH_GROUP`). Omitting
`plan` selects `BASIC`. The plans are Basic Membership ($11.99/month),
Organizer (public) ($24.99/month), Church Individual ($299/month), and
Church Group ($999/month).

Configure the corresponding recurring Stripe Price IDs on the server using
`STRIPE_PRICE_BASIC`, `STRIPE_PRICE_ORGANIZER`,
`STRIPE_PRICE_CHURCH_INDIVIDUAL`, and `STRIPE_PRICE_CHURCH_GROUP`.
Each configured membership plan must use a distinct Price ID.
Checkout uses the verified enrollment's plan, not a browser-supplied price.
Verification returns the selected plan with the checkout authorization.

`POST /api/membership/resend-verification` accepts an optional `plan` to
select an existing enrollment. Without it, the most recent pending enrollment
for the email is used; if none exists, the request starts a Basic enrollment
as before. Pending enrollments for different plans can coexist, but only one
checkout per email can be in progress. Checkout claims use PostgreSQL
transaction-scoped advisory locks to enforce this across server instances.
