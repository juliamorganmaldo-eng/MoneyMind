#!/usr/bin/env bash
# Pre-commit secret-leak audit.
#
# Reads live secret values from web/.env at RUNTIME into shell variables,
# then greps the staged diff for matches WITHOUT ever printing the values
# themselves. Only labels and ✅/❌ are emitted.
#
# Usage (from repo root):
#   ./scripts/audit-secrets.sh
# Exit code: 0 if clean, 1 if any check found a hit.
#
# Design notes:
#   • set +x is enforced — no shell tracing that would echo values.
#   • Each scan() pipes git-diff into `grep -Fq` (quiet) so even if a
#     match exists, the matched line is never written to stdout.
#   • Only a controlled allow-list of variable names is read from .env;
#     we do not source .env (that would execute arbitrary code if the
#     file were ever tampered with).
#   • Pattern-based scans (AWS, Stripe, PEM, sandbox-token UUIDs) use
#     regular expressions in the script source — they describe shape,
#     not value, so the script itself stays safe to commit.

# NOTE: deliberately NOT using `set -e`. Each scan returns its own status
# via the global `failed` variable; we want every check to run, not bail on
# the first match. We do want `-u` and pipefail.
set -uo pipefail
set +x   # belt-and-braces: refuse to be run with -x

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/web/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found — cannot run audit without live values to compare against." >&2
  exit 2
fi

# Read a single VAR=value line from .env, return the value via stdout.
# Strips optional surrounding double or single quotes. Multi-line values
# are not supported — none of our env vars use them.
read_env_var() {
  local key="$1"
  local val
  val=$(grep -E "^${key}=" "$ENV_FILE" | head -1 | sed -E "s/^${key}=//") || true
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"
  printf '%s' "$val"
}

# Load secrets into variables. THESE VARIABLES ARE NEVER PRINTED.
SESSION_SECRET=$(read_env_var SESSION_SECRET)
ENCRYPTION_KEY=$(read_env_var ENCRYPTION_KEY)
DATABASE_URL=$(read_env_var DATABASE_URL)
PLAID_CLIENT_ID=$(read_env_var PLAID_CLIENT_ID)
PLAID_SECRET_SANDBOX=$(read_env_var PLAID_SECRET_SANDBOX)
RESEND_API_KEY=$(read_env_var RESEND_API_KEY)

# Extract just the password from DATABASE_URL: postgresql://user:PASS@host/db
DB_PASSWORD=""
if [[ "$DATABASE_URL" =~ postgresql://[^:]+:([^@]+)@ ]]; then
  DB_PASSWORD="${BASH_REMATCH[1]}"
fi

# A value is "scannable" if it's non-empty and not an obvious placeholder.
is_real_value() {
  local v="$1"
  [ -n "$v" ] || return 1
  case "$v" in
    *PLACEHOLDER*|CHANGE_ME|change-me-*|replace-me-*) return 1 ;;
  esac
  return 0
}

failed=0

# scan: search staged diff for an exact-string needle without echoing it.
scan() {
  local label="$1"
  local needle="$2"
  if ! is_real_value "$needle"; then
    printf '  %-32s ⊘ skipped (not configured / placeholder)\n' "$label"
    return 0
  fi
  if git diff --cached | grep -Fq -- "$needle"; then
    printf '  %-32s ❌ FOUND IN STAGED DIFF\n' "$label"
    failed=1
    return 1
  fi
  printf '  %-32s ✅ not in diff\n' "$label"
  return 0
}

# scan_pattern: regex check — pattern itself is in the script source, so
# the script stays safe to commit. Catches shapes of common secret types.
scan_pattern() {
  local label="$1"
  local pattern="$2"
  if git diff --cached | grep -Eq -- "$pattern"; then
    printf '  %-32s ⚠  pattern matched (review)\n' "$label"
    failed=1
    return 1
  fi
  printf '  %-32s ✅ no matches\n' "$label"
  return 0
}

echo
echo "═══════════════════════════════════════════════════════════════"
echo "  Secret-leak audit (values read from web/.env at runtime)"
echo "═══════════════════════════════════════════════════════════════"

echo
echo "Staged-diff scan against live values:"
scan "SESSION_SECRET"        "$SESSION_SECRET"
scan "ENCRYPTION_KEY"        "$ENCRYPTION_KEY"
scan "DATABASE_URL (full)"   "$DATABASE_URL"
scan "DB password"           "$DB_PASSWORD"
scan "PLAID_CLIENT_ID"       "$PLAID_CLIENT_ID"
scan "PLAID_SECRET_SANDBOX"  "$PLAID_SECRET_SANDBOX"
scan "RESEND_API_KEY"        "$RESEND_API_KEY"

echo
echo "Pattern scan (catches secrets we may not have in .env yet):"
# Plaid sandbox access tokens look like: access-sandbox-<UUIDv4>
scan_pattern "Plaid access token (any env)" 'access-(sandbox|development|production)-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
scan_pattern "AWS access key (AKIA…)"      'AKIA[0-9A-Z]{16}'
scan_pattern "Stripe live key"             'sk_live_[A-Za-z0-9]{20,}'
scan_pattern "Stripe restricted key"       'rk_live_[A-Za-z0-9]{20,}'
scan_pattern "PEM private key block"       '-----BEGIN [A-Z ]*PRIVATE KEY-----'
scan_pattern "GitHub token (ghp_/gho_…)"   '\bgh[pousr]_[A-Za-z0-9]{30,}'
scan_pattern "Anthropic API key"           'sk-ant-[A-Za-z0-9_-]{20,}'
scan_pattern "Slack token"                 'xox[abprs]-[A-Za-z0-9-]{10,}'
scan_pattern "Resend API key (re_…)"       're_[A-Za-z0-9_]{20,}'

echo
echo "Dangerous file paths in stage:"
DANGER=$(git diff --cached --name-only | grep -iE '\.env$|\.db$|\.db-shm$|\.db-wal$|node_modules|cookies?\.txt|^_|/_' || true)
if [ -n "$DANGER" ]; then
  echo "  ❌ DANGER:"
  printf '%s\n' "$DANGER" | sed 's/^/    /'
  failed=1
else
  echo "  ✅ clean (no .env, .db*, node_modules, cookies, _-prefixed files)"
fi

echo
if [ "$failed" -eq 0 ]; then
  echo "═══ AUDIT PASSED ═══"
  exit 0
fi
echo "═══ AUDIT FAILED — review hits above before committing ═══"
exit 1
