# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, report
privately via GitHub's **Security → Advisories → Report a vulnerability** on this
repository. You'll get a response as soon as possible.

## Operating this server safely

`ghost-mcp-secure` is **read-only by default**. Every mutating capability is gated
behind an explicit environment flag (see the Security model in the README). When you
run it:

- **Keep your Ghost Admin API key secret.** It is never logged or returned to the model.
  Never commit your `.env` (it is git-ignored by default).
- Use a **dedicated, revocable** Ghost custom integration so you can rotate just this
  key without affecting anything else.
- Enable **only the flags you need.** Keep `GHOST_ALLOW_DELETE` and `GHOST_ALLOW_SYSTEM`
  off unless you specifically need them for a given session.
- For **remote / hosted** deployments, put the server behind authentication (OAuth 2.1)
  and serve it over HTTPS. Do not expose an unauthenticated endpoint that holds an
  Admin key.

## Supported versions

The latest version on the default branch is supported.
