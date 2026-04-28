# MoneyMind — Security Notes (web/)

This document covers the security posture of the web app scaffolded in
`web/`. It does **not** cover the MCP server in the parent directory.

Last updated: 2026-04-27. Scope: authentication + Plaid Link integration
(sandbox) + cursor-based transaction sync. See "Not yet implemented" at
the bottom for what is still out of scope.

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
- Required env vars (the app refuses to boot without `SESSION_SECRET` ≥ 32
  chars and a valid `ENCRYPTION_KEY`):
  - `SESSION_SECRET` — signs session cookies. Generate with
    `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`.
  - `ENCRYPTION_KEY` — base64-encoded; must decode to ≥ 32 bytes. Used to
    encrypt Plaid access tokens at rest. Generate with
    `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
  - `DATABASE_URL` — Postgres connection string.
  - `PLAID_CLIENT_ID`, `PLAID_SECRET_SANDBOX` (and `PLAID_ENV=sandbox`).
    Per-environment secrets so dev/prod can be rotated independently.
  - `PORT` — defaults to 3001.
  - `NODE_ENV` — set to `production` in deployed environments.
- The parent MCP server reads its own `.env` from
  `../plaid-integration/.env` and is unaffected by `web/.env`.

## Plaid access-token encryption (at rest)

- **Algorithm:** `aes-256-gcm` (authenticated encryption — tampered
  ciphertexts fail to decrypt).
- **Key:** `ENCRYPTION_KEY` env var, base64. Must decode to ≥ 32 bytes;
  the first 32 are used as the AES key. The app calls
  `assertEncryptionKey()` at startup and `process.exit(1)`s with a fatal
  log if missing or too short.
- **IV:** 12 bytes (GCM standard), random per encryption via
  `crypto.randomBytes`. Same plaintext encrypted twice yields different
  ciphertexts (verified by `test/crypto.test.js`).
- **Auth tag:** 16 bytes, captured via `cipher.getAuthTag()` and verified
  on decrypt. Tampering anywhere in the IV, tag, or ciphertext causes
  `decipher.final()` to throw.
- **On-disk format (column `plaid_items.access_token_encrypted`):**
  base64 of `iv (12 bytes) || tag (16 bytes) || ciphertext`.
- **Helper module:** `web/lib/crypto.js` — `encrypt(string)`,
  `decrypt(string)`, `assertEncryptionKey()`. The key is loaded once and
  cached. Tests in `web/test/crypto.test.js` cover round-trip,
  IV uniqueness, tamper rejection, truncation rejection, and unicode.
  Run with `node --test test/crypto.test.js` from `web/`.
- **Token-handling rules (enforced by code review, not just convention):**
  - Plaintext access tokens live only in local variables inside
    `routes/plaid.js`; the variable is set to `null` immediately after
    `encrypt()` returns.
  - Tokens are **never** written to the database in plaintext, **never**
    logged (Plaid SDK errors are scrubbed by `safePlaidError()` —
    only `error_type`, `error_code`, `display_message` are forwarded),
    **never** returned to the browser.
  - The dashboard JSON response from `/api/plaid/exchange-public-token`
    contains only `{ ok, institution_name, account_count }`. The token
    is not in the response, and the dashboard view never queries the
    encrypted column.

## Plaid endpoints — scope and isolation

- **`POST /api/plaid/create-link-token`** — auth-required. The Link token
  is created with `client_user_id = String(req.session.userId)`, so
  Plaid scopes the resulting connection to this user from the start.
- **`POST /api/plaid/exchange-public-token`** — auth-required. The
  exchange and all DB writes use `req.session.userId` from the session,
  not any value the client could spoof. The handler also defensively
  checks that the inserted `plaid_items.user_id` matches the session
  user — if a Plaid `item_id` collision across two MoneyMind users were
  ever to occur, the request is rejected with 409 and the transaction
  rolls back.
- The Plaid router applies `requireAuth` via `router.use(requireAuth)`
  so any future endpoint added to it inherits the gate by default.
- `express.json()` is scoped to the Plaid router only; the urlencoded
  parser used by the auth forms is unchanged.

## Per-user data isolation

- `plaid_items.user_id` and `accounts.user_id` are both `NOT NULL` with
  `ON DELETE CASCADE` to `users(id)`. Every row has a strong owner.
- Indexes on `plaid_items(user_id)` and `accounts(user_id)` make
  user-scoped queries efficient, removing the temptation to omit the
  filter for performance.
- `accounts` has `UNIQUE (user_id, plaid_account_id)` — the same Plaid
  account can never appear twice for one user (idempotent upserts), and
  the constraint is per-user, so two different MoneyMind users can both
  hold the same `plaid_account_id` without colliding (this can happen
  in sandbox where account IDs are deterministic).
- **Every** read of `plaid_items` or `accounts` filters by
  `req.session.userId`. The dashboard query also redundantly enforces
  `accounts.user_id = plaid_items.user_id` in the join `ON` clause as
  defense-in-depth — a typo or schema drift elsewhere shouldn't be able
  to leak another user's accounts.

## Transactions — sync, scope, schema isolation

- **Sync algorithm:** cursor-based `/transactions/sync`. Each
  `plaid_items` row carries a `cursor`; the syncer pages through Plaid
  (`while has_more`) and persists the new `next_cursor` only after all
  added/modified/removed rows for that page have been written, in a
  single DB transaction. This makes a partial failure recoverable —
  the next sync replays the same delta.
- **Decrypted-token lifetime:** the access token is decrypted right
  before the Plaid call loop, held in a single local `accessToken`
  variable, and explicitly nulled before any DB work runs. It is never
  written to a log, never returned to the browser, never persisted in
  any form except the encrypted column.
- **Schema-level multi-tenant guarantee:** the `transactions` table has
  a **composite foreign key** `(user_id, plaid_account_id) →
  accounts(user_id, plaid_account_id)`. Because `accounts` enforces
  `UNIQUE (user_id, plaid_account_id)`, this means a transaction row can
  *only* be linked to an account belonging to the same user — even if
  application code tries to set the wrong `user_id`, Postgres rejects
  the insert with an FK violation. This is the strongest isolation
  primitive in the schema.
- **Per-user uniqueness:** `UNIQUE (user_id, plaid_transaction_id)`
  makes the sync idempotent (re-running yields zero new inserts) and
  scopes the constraint per-user, so two users could in principle hold
  the same Plaid `transaction_id` without colliding (this happens in
  sandbox where transaction IDs are deterministic).
- **Endpoints (both auth-required, both user-scoped):**
  - `POST /api/transactions/sync` — runs sync for `req.session.userId`
    only (the SELECT for items is `WHERE user_id = $1`). The response
    is **counts only** (`{ added_count, modified_count, removed_count }`)
    — no transaction payload. The browser fetches data through the
    next endpoint.
  - `GET /api/transactions?month=&search=&account_id=&page=&per_page=`
    — returns a curated column subset (`id, plaid_account_id, name,
    merchant_name, amount, iso_currency_code, date, pending, category`)
    for the session user only. `location`, `category_id`, `plaid_item_id`,
    and `plaid_transaction_id` are deliberately not shipped to the
    browser. Every filter value is bound through a parameterized query
    placeholder; `search` is run through ILIKE with `%` and `_` escaped
    to literal so the user can't smuggle SQL wildcards. Crucially, the
    `user_id = $1` filter is always the *first* predicate, before any
    client-supplied value — so even if a user crafts an `account_id`
    that belongs to another user, the query returns zero rows because
    the (user_id, plaid_account_id) pair doesn't exist for them.
  - `GET /api/accounts` — returns the session user's accounts joined
    with `plaid_items.institution_name`. Used by the dashboard
    (Net Position + grouped cards) and the transactions filter
    dropdown. Both halves of the join enforce `user_id` equality.

## Categories — schema and ownership

- **Table `categories(id, user_id, name, display_order)`** with
  `UNIQUE(user_id, name)` (no name dupes per user) and
  `UNIQUE(user_id, id)` (the second one exists solely so the FK below
  can target it).
- **Composite FK** `transactions.(user_id, category_id) →
  categories.(user_id, id)` with `ON DELETE SET NULL`. Same pattern as
  `accounts`: a transaction can never reference a category belonging to
  a *different* user — even if buggy app code tries to set the wrong
  `user_id`, Postgres rejects the write with an FK violation.
- **Default-seeding on registration** is in the same DB transaction as
  the user insert (`routes/auth.js`). If the 5 default categories
  fail to insert, the whole registration rolls back — no orphan users
  with zero categories.
- **`category_source`** on `transactions` is a `CHECK`-bounded text
  enum (`'plaid_mapped'` or `'user_override'`). On Plaid resync, rows
  whose `category_source = 'user_override'` keep their `category_id`
  untouched — only the display-side Plaid metadata is refreshed
  (`plaid_category_primary`, `plaid_category_detailed`).
- **Endpoints (auth-required, user-scoped):**
  - `GET /api/categories` — lists the session user's categories with
    current-month `transaction_count` and `current_month_spend`.
  - `PATCH /api/categories/:id` — rename. Filters `WHERE id=$id AND
    user_id=$session`; a cross-user attempt returns 404 (the canonical
    "not yours" response, indistinguishable from "doesn't exist" so we
    don't leak existence). Length 1–30, no per-user duplicates.
  - `PATCH /api/transactions/:id/category` — reassign. Validates **both**
    that the target category and the transaction belong to the session
    user before writing. Sets `category_source = 'user_override'`. The
    `apply_to_all_from_merchant` branch is `WHERE user_id = $session AND
    merchant_name = $1` — never touches another user's rows.

## Budget limits + low-balance thresholds — money is integer cents

- **Tables.** `budget_limits(user_id, category_id, monthly_limit_cents,
  ...)` and `low_balance_thresholds(user_id, account_id, threshold_cents,
  enabled, ...)`. Both have `UNIQUE(user_id, X)` so each user has at
  most one limit per category and one threshold per account.
- **Composite FKs (schema-level multi-tenant guarantee, same pattern as
  `transactions`):**
  - `budget_limits.(user_id, category_id) → categories.(user_id, id)`
  - `low_balance_thresholds.(user_id, account_id) → accounts.(user_id, id)`
  - To enable the latter we added `UNIQUE(user_id, id)` to `accounts`.
  Result: a budget limit can never reference a category from another
  user, and a threshold can never reference another user's account —
  the database itself rejects such writes, even if buggy app code tries.
- **All money is INTEGER cents.** `monthly_limit_cents` is `INTEGER` with
  `CHECK > 0`; `threshold_cents` is `INTEGER` with `CHECK >= 0`. We
  never store floating-point money. The transactions table's
  `amount NUMERIC(14,2)` is converted on the SQL side via
  `ROUND(amount * 100)::int` — exact arithmetic, no float involved.
- **API input validation.** Every body field that should be a count of
  cents is checked with `Number.isInteger()` — which strictly rejects
  `300.5`, `'300'`, `NaN`, `null`, `Infinity`, etc. Negative values are
  rejected at the same boundary. Malformed input → HTTP 400 with no DB
  side effects. This is the single source of truth for input shape;
  the DB CHECKs are a backstop, not the only line of defense.
- **Endpoints (auth-required, user-scoped, ownership-validated):**
  - `GET    /api/budget-limits` — list with current-month spend, pct, status.
  - `PUT    /api/budget-limits/:category_id` — upsert (or DELETE on 0/null).
    Validates category ownership; returns 404 cross-user.
  - `GET    /api/budget-limits/:category_id/transactions` — drill-down.
    Validates category ownership; returns 404 cross-user.
  - `GET    /api/low-balance-thresholds` — list with current balances.
  - `PUT    /api/low-balance-thresholds/:account_id` — upsert. Validates
    account ownership; returns 404 cross-user.
  - `DELETE /api/low-balance-thresholds/:account_id` — delete. The
    `WHERE user_id=$session AND account_id=$1` filter guarantees a
    cross-user attempt deletes nothing and the response is 404 (no
    "deleted=0" leak).

## Subscription audit (recurring detection)

- **Tables.** `recurring_charges(user_id, merchant_key, display_name,
  category_id, cadence, …)` and `recurring_charge_actions(user_id,
  recurring_charge_id, action, notes)`. Same composite-FK pattern as
  the rest of the app: `recurring_charges.(user_id, category_id) →
  categories.(user_id, id)`, and
  `recurring_charge_actions.(user_id, recurring_charge_id) →
  recurring_charges.(user_id, id)` (we added `UNIQUE(user_id, id)` to
  `recurring_charges` for this). A row in either child table can never
  reference a parent belonging to a different user — the database
  rejects such writes.
- **Detection algorithm.** `lib/recurring-detection.js`. The pure
  function `detectFromTransactions(txns, today)` is unit-tested with
  zero DB dependencies; the wrapper `detectRecurring(userId)` queries
  the user's last 18 months of positive-amount transactions, scoped
  by `WHERE user_id = $1`, excluding Plaid `Transfer/Payment/Income`
  primary categories. Status enum is bounded by a CHECK constraint.
- **Persistence.** `lib/recurring-persistence.js` upserts detected rows
  per user and marks no-longer-detected rows as `'ended'`. **It never
  modifies rows where `is_user_dismissed = TRUE`**, even on the UPSERT
  path (the `ON CONFLICT … WHERE` clause re-asserts that). The dismiss
  decision is durable across resyncs.
- **Hook into transactions sync.** After `syncTransactionsForUser`
  finishes its main loop, it calls `detectRecurring + syncDetectionResults`
  inside a `try/catch` — a detection failure logs but does not roll back
  the (already-saved) transactions.
- **Endpoints (auth-required, user-scoped, ownership-validated):**
  - `GET    /api/subscriptions` — list active + ended for this user;
    response includes `annual_total_cents` aggregate.
  - `GET    /api/subscriptions/:id` — drill-down. Validates ownership;
    404 cross-user. The transactions returned are filtered by the
    same merchant-key clustering function used in detection, so the
    drill-down is exactly the rows that fed the cluster.
  - `POST   /api/subscriptions/:id/action` — record `not_recurring`,
    `cancelled`, or `reminder_set`. Validates `action` against an
    allow-list (no free-form values reach SQL); validates ownership;
    404 cross-user. Writes the action row + (depending on action)
    updates the recurring_charges row in a single transaction.
  - `GET    /api/subscriptions/duplicates` — pairs detected via
    `lib/duplicate-detection.js`. The query that builds the pair
    candidates is `WHERE user_id = $1` — never returns another user's
    charges.
  - `POST   /api/subscriptions/sync` — manual re-detect for the session
    user. Calls the same algorithm + persistence as the post-sync hook.

## Net worth, balance snapshots, insights, user settings

- **Tables.**
  - `balance_snapshots(user_id, account_id, snapshot_date, balance_cents,
    available_balance_cents, iso_currency_code)` — one row per (user,
    account, day). UNIQUE(user_id, account_id, snapshot_date) plus a
    composite FK `(user_id, account_id) → accounts(user_id, id)`. Last
    write wins for same-day re-syncs.
  - `accounts.is_asset_override BOOLEAN` (nullable) and
    `accounts.excluded_from_net_worth BOOLEAN NOT NULL DEFAULT FALSE`
    let the user override Plaid's classification or remove an account
    from net-worth math entirely.
  - `user_settings(user_id, savings_rate_target_pct)` — one row per
    user, `UNIQUE(user_id)`, with `CHECK (target BETWEEN 0 AND 100)`.
    Seeded on registration in the same DB transaction as the user.
- **All money is INTEGER cents.** Balances stored as cents on
  `balance_snapshots`. Net-worth math sums cents directly. Server-side
  validation rejects floats and out-of-range values on every PATCH that
  takes a numeric (`is_asset_override`, `excluded_from_net_worth`,
  `savings_rate_target_pct`).
- **Endpoints (all auth-required, all user-scoped):**
  - `GET    /api/net-worth` — current totals + breakdown by account
    type + per-account list. Filters `WHERE user_id = $1` on the
    accounts query; classification computed in app code via
    `lib/account-classification.js`.
  - `GET    /api/net-worth/history?months=N` — time-series rebuilt
    from `balance_snapshots` (carry-forward per account: each date
    sums the latest snapshot ≤ date). Both the snapshot SELECT and
    the accounts SELECT filter by user_id.
  - `POST   /api/balances/refresh` — calls Plaid `accountsBalanceGet`
    using a freshly-decrypted access token (held briefly, nulled after
    each item). Updates `accounts.current_balance` and writes new
    snapshot rows. The DB UPDATE matches by `(user_id, plaid_account_id)`
    so an item from another user could never collide.
  - `PATCH  /api/accounts/:id/classification` — validates input as
    boolean-or-null for `is_asset_override`, boolean for
    `excluded_from_net_worth`. The UPDATE WHERE filters by `user_id`
    so a cross-user attempt returns 404.
  - `GET    /api/spending/by-month?months=N` — aggregates via
    `lib/transaction-flow.js` (income/spending/transfer/ignore). Single
    SELECT with `WHERE user_id = $1`; bucketing in app code.
  - `GET    /api/savings-rate?months=N` — same pattern. Returns
    `savings_rate_pct = null` when income is 0 (never divides by zero).
  - `GET    /api/user-settings`, `PATCH /api/user-settings` — single
    row keyed by `user_id`. UPSERT; integer 0–100 validated at the
    edge before any DB write (DB CHECK is the backstop).
- **Sync hook.** After every successful `syncTransactionsForUser` (HTTP
  or programmatic), the server upserts a `balance_snapshots` row per
  account using the current `accounts.current_balance` value, scoped by
  `user_id`. Wrapped in try/catch so a snapshot failure doesn't roll
  back the source-of-truth transactions.

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

1. **Webhooks.** Plaid `TRANSACTIONS_SYNC_UPDATES_AVAILABLE` and other
   webhooks are not handled — sync today is user-triggered (button) only.
2. **CSRF tokens.** `sameSite=lax` blocks the common cross-site vectors
   for the current routes (including the `/api/plaid/*` POSTs, since they
   require an authenticated session and `lax` blocks cookies on
   cross-site POSTs by default). Per-form CSRF tokens (e.g. via `csurf`
   or a double-submit cookie) should still be added before the app
   accepts any state-changing request from a less trusted client.
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
