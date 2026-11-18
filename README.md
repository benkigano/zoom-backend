# zoom-backend
Backend for Zoom + Wix integration

## Membership activation confirmation

After initial activation, the webhook attempts to email a membership
confirmation. Repeated webhook deliveries do not resend it. Because delivery
is not tracked persistently, a failed send or a process interruption after
activation can leave the confirmation unsent; it is not retried automatically.

`GET /api/membership/checkout-status?session_id=...` returns only `status`:
`ACTIVE` when the completed enrollment matches an active subscription,
otherwise `PENDING`. The session ID is a bearer value: anyone holding it can
check the status, so do not share it. The endpoint does not activate membership.
