# MoneyMind — Security Notes (web/)

This document covers the security posture of the web app scaffolded in
`web/`. It does **not** cover the MCP server in the parent directory.

Last updated: 2026-04-21. Scope: authentication scaffold only
(login, register, dashboard). See "Not yet implemented" at the bottom for
everything that is deliberately out of scope at this step.

---

## Password handling

- Passwords are hashed with **bcrypt** using **12 rounds** (see
  `web/routes/auth.js:BCRYPT_ROUNDS`). 12 is a reasonable 2026 default;
  raise it if/when login latency on target hardware allows.
- Plaintext passwords are **never persisted**. The only place the raw
  password exists is the inbound request body and the `bcrypt.hash` /
  `bcrypt.compare` call frames — both transient.
- Passwords are **never logged**. The only error logging in `app.js` emits
  `err.stack` / `err.message`; no request body is logged anywhere in the
  codebase. If you add request logging later, make sure it strips
  `password`, `inviteCode`, and any future credential-bearing fields.
- Login uses a constant-time comparison (bcrypt does this internally) and
  runs a dummy `bcrypt.compare` against a fixed hash when the email is not
  found, so response time does not leak whether the email exists. Both the
  "user not found" and "wrong password" paths return the same generic
  error string.
- Minimum password length is **10 characters** on registration. There is
  no maximum (bcrypt's 72-byte limit applies implicitly; revisit if you
  expect passphrases that may exceed it).

## Session management

- Sessions are signed with `SESSION_SECRET` (required, must be ≥ 32 chars;
  the app refuses to start without it).
- Session state is stored in Postgres via `connect-pg-simple` (table
  `session`), so sessions persist across server restarts and deploys.
- Session cookie flags:
  - `httpOnly: true` — not accessible to JavaScript in the browser.
  - `sameSite: 'lax'` — blocks cross-site POSTs that would otherwise ride
    the session cookie (gives meaningful CSRF protection for state-changing
    routes that are `POST`).
  - `secure: true` in production (set via `NODE_ENV=production`). Off in
    dev so `http://localhost:3001` still works.
  - `maxAge: 14 days` with `rolling: true` — each request extends the
    cookie lifetime, so active users stay signed in indefinitely and
    abandoned sessions expire.
  - Cookie name is the non-default `moneymind.sid` to avoid leaking the
    framework identity (`connect.sid`).
- On **login** and on **registration**, the session ID is regenerated
  (`req.session.regenerate`) before the `userId` is attached. This defeats
  session-fixation attacks where an attacker plants a known session ID in
  the victim's browser before login.
- On **logout**, the session is destroyed server-side (`req.session.destroy`)
  and the cookie is cleared client-side (`res.clearCookie`).
- `x-powered-by` is disabled to avoid leaking the framework version.

## Secrets

- All secrets live in `web/.env`. That file is listed in `web/.gitignore`
  and must never be committed. `web/.env.example` is the committed
  template with placeholder values only.
- Required env vars:
  - `SESSION_SECRET` — signs session cookies. Generate with
    `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`.
  - `DATABASE_URL` — Postgres connection string.
  - `PORT` — defaults to 3001.
  - `NODE_ENV` — set to `production` in deployed environments.
- The parent MCP server reads its own `.env` from
  `../plaid-integration/.env` and is unaffected by `web/.env`.

## Invite-only registration

- Registration requires a valid, **unused** invite code. 10 codes are
  generated the first time the app runs against an empty `invite_codes`
  table (see `web/lib/bootstrap.js`) and printed to the terminal once.
  They are not printed again; save them on first boot.
- Codes are generated with `crypto.randomBytes` over a 31-char unambiguous
  alphabet (no `0/O/1/I/L`), giving ~60 bits of entropy per code — far
  more than is guessable at any reasonable rate against a local server.
- The registration flow uses a transaction with `SELECT ... FOR UPDATE` on
  the invite row, so two concurrent registrations cannot consume the same
  code.

## Database access

- All queries use parameterized SQL via `pg` (`$1`, `$2`, …). There is no
  string interpolation of user input into SQL anywhere in this scaffold.
- Emails are lowercased on write and on lookup, so case variants cannot be
  used to create duplicate accounts.

---

## Not yet implemented (explicit scope limits for this step)

This scaffold is auth-only. The following are **not** wired up and must be
added in later steps before the app is useful or production-ready:

1. **Plaid integration.** No Plaid client, no link token endpoint, no
   account/transaction sync. The MCP server in the parent directory has
   its own Plaid wiring; the web app does not share it.
2. **Per-user data isolation.** There is currently no user-scoped data
   stored, so there is nothing to isolate yet. When finance data is
   introduced, every query touching that data must filter by
   `req.session.userId` and every FK must be enforced at the schema level.
   Do not rely on route checks alone.
3. **CSRF tokens.** `sameSite=lax` blocks the common vectors for the
   current routes, but proper per-form CSRF tokens (e.g. via `csurf` or a
   double-submit cookie) should be added before the app accepts any
   state-changing request beyond login/register/logout.
4. **Rate limiting / brute-force protection.** No limits on login or
   registration attempts. Add `express-rate-limit` (or similar) on
   `/login` and `/register` before opening this to the public internet.
5. **Email verification.** New accounts are active immediately. No email
   is sent, and the address is not verified.
6. **Password reset / account recovery.** No reset flow. If you lose your
   password today, an admin has to update `password_hash` in Postgres by
   hand.
7. **2FA / MFA.** Not implemented.
8. **Security headers.** `helmet` is not installed. Add it (with a CSP
   tuned for the templates) before exposing the app publicly.
9. **Audit logging.** Successful/failed logins, registrations, and logouts
   are not logged to a durable audit trail.
10. **TLS.** The app serves plain HTTP on `:3001`. Put it behind a TLS
    terminator (or `https` module) before it leaves localhost.
