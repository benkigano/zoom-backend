# zoom-backend
Backend for Zoom + Wix integration

## Authenticated member subscription lookup

`GET /api/membership/me` returns the subscription for the signed-in Wix
member. It does not accept query parameters or a request body. The Wix Astro
server must authenticate the member using Wix's server-side member context,
establish that the member's email is verified, and send a short-lived signed
assertion to this endpoint. Browser code must never receive the assertion
secret or be allowed to choose the asserted email.

Configure these independently in the Wix server environment and Render:

- `MEMBER_PORTAL_ASSERTION_SECRET`: the same randomly generated secret on both
  servers, at least 32 UTF-8 bytes. Do not expose or log it.
- `MEMBER_PORTAL_ASSERTION_AUDIENCE`: the same audience value on both servers,
  for example `court-of-compassion-member-portal-production`.

The Wix server sends `Authorization: Bearer <assertion>`. The assertion is
`base64url(JSON claims).lowercase-hex-HMAC-SHA256`, with the HMAC calculated
over the encoded claims segment using `MEMBER_PORTAL_ASSERTION_SECRET`. The
claims are:

```json
{
  "iss": "wix-astro-member-portal",
  "aud": "court-of-compassion-member-portal-production",
  "iat": 1795122000,
  "exp": 1795122060,
  "endpoint": "GET /api/membership/me",
  "sub": "verified Wix member ID",
  "email": "verified-member@example.com",
  "email_verified": true
}
```

`iat` and `exp` are Unix seconds. Assertions may be valid for at most 60
seconds; the backend allows 30 seconds of clock skew. The audience must match
the Render configuration. The backend derives the subscription lookup email
only from a successfully verified assertion. Invalid configuration fails
closed.

The response contains only `planCode`, `planName`, `status`,
`currentPeriodEnd`, and `cancelAtPeriodEnd` under `subscription`; an
authenticated member without a matching subscription receives
`{"subscription":null}`. Responses are not cacheable.

## Membership activation confirmation

After initial activation, the webhook attempts to email a membership
confirmation. Repeated webhook deliveries do not resend it. Because delivery
is not tracked persistently, a failed send or a process interruption after
activation can leave the confirmation unsent; it is not retried automatically.

`GET /api/membership/checkout-status?session_id=...` returns only `status`:
`ACTIVE` when the completed enrollment matches an active subscription,
otherwise `PENDING`. The session ID is a bearer value: anyone holding it can
check the status, so do not share it. The endpoint does not activate membership.

## Court Study membership continuation

For a pending community-hosted Court Study, Wix can use the existing
request-specific continuation token to start membership enrollment without
accepting an email address from the browser:

1. `POST /api/court-study/membership-enroll` with
   `{"requestId":"...","token":"...","plan":"BASIC"}`. Accepted plans are
   `BASIC`, `CHURCH_INDIVIDUAL`, and `CHURCH_GROUP`, matching the existing
   Court Study subscription choices. The backend verifies the continuation,
   loads the request's stored organizer email, and sends the existing
   membership verification email to that address. Caller-supplied `email`,
   `memberEmail`, `memberId`, or `organizerEmail` fields are rejected.
2. The successful response is either
   `{"success":true,"status":"VERIFICATION_REQUIRED"}` or
   `{"success":true,"status":"ACTIVE_SUBSCRIBER","requestId":"..."}`.
   If the existing enrollment cannot safely continue,
   `MEMBERSHIP_ENROLLMENT_UNAVAILABLE` is returned with HTTP 409.
   The former uses the existing `/api/membership/verify` and
   `/api/membership/checkout` flow. It does not create another checkout
   system.
3. The verification email link carries `courtStudyRequestId` and
   `courtStudyToken` in its URL fragment. Wix must read and retain this pair
   before submitting the existing verification token. Keep it in
   `sessionStorage` or another short-lived browser state across the Stripe
   redirect; do not put the continuation token in a Stripe success or cancel
   URL, analytics event, or log.
4. After the existing `/api/membership/checkout-status?session_id=...`
   returns `{"status":"ACTIVE"}`, or immediately for
   `ACTIVE_SUBSCRIBER`, call
   `POST /api/court-study/membership-continuation` with
   `{"requestId":"...","token":"..."}`. The backend independently checks the
   active subscription against the email stored on that request before
   approving it. Success is
   `{"success":true,"requestId":"...","status":"APPROVED","zoomReady":true}`;
   an inactive subscription returns HTTP 409 with
   `{"success":false,"requestId":"...","status":"MEMBERSHIP_NOT_ACTIVE","zoomReady":false}`.
   Other ineligible requests also remain unapproved.

Both continuation endpoints are rate limited and return `Cache-Control:
no-store`. If the one-time Court Study Checkout is cancelled, its return URL
contains only `requestId`; Wix must restore the continuation token from the
short-lived state saved before leaving for Stripe. No database migration or
schema change is required.
