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
