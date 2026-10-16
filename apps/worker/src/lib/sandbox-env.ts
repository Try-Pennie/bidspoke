// Which worker secrets reach a user-authored code-node sandbox (#108).
//
// A code node runs author-written JS. It legitimately needs partner credentials
// (Equifax, Tripoint, ...) and the org's environment variables, but it has no
// reason to read the platform's master secrets (the Supabase service-role key,
// the secret-encryption key, the SSN pepper, the Cloudflare token, etc.). Those
// must never be in reach of user scripts.
//
// Partner credentials are NOT in the typed Env (they're dynamic worker secrets
// or DB-managed env vars), so they aren't classified below and default to
// exposed at runtime — that is the intentional "partner creds reach code nodes"
// path. The policy below classifies every TYPED string binding, and adding a new
// string field to Env without classifying it here is a COMPILE error, so a newly
// added master secret can't be silently shipped to sandboxes.
import type { Env } from '../index'

// The string-valued keys of Env (excludes KV/DO/dispatch/Hyperdrive bindings).
type EnvStringKey = { [K in keyof Env]-?: NonNullable<Env[K]> extends string ? K : never }[keyof Env]

// 'block' = platform master secret / sensitive credential — withheld from code
// nodes. 'expose' = non-secret config safe to pass through.
export const ENV_SANDBOX_POLICY: Record<EnvStringKey, 'block' | 'expose'> = {
  // Master secrets and sensitive credentials — never exposed.
  SUPABASE_SECRET_KEY: 'block',
  API_KEY_MAP: 'block',
  CLOUDFLARE_API_TOKEN: 'block',
  CLOUDFLARE_LOGS_TOKEN: 'block',
  CLOUDFLARE_ACCOUNT_ID: 'block',
  SECRET_ENCRYPTION_KEY: 'block',
  SECRET_ENCRYPTION_KEY_NEXT: 'block',
  SSN_HASH_PEPPER: 'block',
  SNOWFLAKE_ACCOUNT: 'block',
  SNOWFLAKE_USER: 'block',
  SNOWFLAKE_PRIVATE_KEY: 'block',
  SNOWFLAKE_DATABASE: 'block',
  SNOWFLAKE_SCHEMA: 'block',
  SNOWFLAKE_WAREHOUSE: 'block',
  SNOWFLAKE_ROLE: 'block',
  // Execution archive identities (#870). Blocked for the same reason as the
  // existing Snowflake credentials, and with one extra: the eraser is the only
  // identity in the account holding DELETE on 13 months of archived identity
  // data, so a code node reaching it could destroy the backup the whole milestone
  // exists to guarantee.
  ARCHIVE_WRITER_USER: 'block',
  ARCHIVE_WRITER_PRIVATE_KEY: 'block',
  ARCHIVE_READER_USER: 'block',
  ARCHIVE_READER_PRIVATE_KEY: 'block',
  ARCHIVE_ERASER_USER: 'block',
  ARCHIVE_ERASER_PRIVATE_KEY: 'block',
  GITHUB_TOKEN: 'block',
  GITHUB_ACTIONS_TOKEN: 'block',
  ANTHROPIC_API_KEY: 'block',
  // A login of the partners page delivery monitor (#2135): never handed to a code node.
  PARTNER_PAGE_MONITOR_PASSWORD: 'block',
  // The Better Stack page for "nobody can be told" (#2063): a code node holding
  // these could raise a false page, or bury a real one under its own.
  BETTERSTACK_OUTAGE_TOKEN: 'block',
  BETTERSTACK_OUTAGE_URL: 'block',
  // Non-secret config — safe to expose.
  SUPABASE_URL: 'expose',
  SUPABASE_PUBLISHABLE_KEY: 'expose',
  SUPABASE_JWKS_URL: 'expose',
  // The client's fetch deadline (#1484); internal plumbing, no code node needs it.
  SUPABASE_REQUEST_DEADLINE_MS: 'block',
  PII_REDACTION_FIELDS: 'expose',
  APP_URL: 'expose',
  SELF_CHECK_URL: 'expose',
  GITHUB_REPO: 'expose',
  // Blocked rather than exposed alongside GITHUB_REPO above: no code node has any
  // reason to know which repository the platform's own scheduled-workflow check
  // watches, and a name nothing needs is cheaper to withhold than to justify.
  GITHUB_CODE_REPO: 'block',
  DEPLOYED_SHA: 'expose', // non-secret: the live worker's git commit (#327)
  SALESFORCE_BULKHEAD_LIMIT: 'expose', // non-secret: SF inflight cap (#312)
  SALESFORCE_BULKHEAD_WAIT_MS: 'expose', // non-secret: at-capacity wait budget
  FIELD_PRESENCE_CAPTURE: 'expose', // non-secret: field-presence capture flag (#419)
  LOCAL_DEV: 'expose', // non-secret: set only in .dev.vars to flag local wrangler dev
  PARTNER_PROBE_ALERTS: 'block', // the reachability probe's own switch (#1274); no script needs it
  ALLOW_PROD_WRITES: 'expose', // non-secret: set only in .dev.vars to opt local dev into prod writes (#669)
}

export const SANDBOX_BLOCKED_ENV_KEYS: ReadonlySet<string> = new Set(
  Object.entries(ENV_SANDBOX_POLICY)
    .filter(([, decision]) => decision === 'block')
    .map(([key]) => key)
)

// Build the string env bindings handed to a code-node sandbox: every string
// worker binding except the blocked master secrets. Partner creds and DB env
// vars (untyped, not in the block-list) pass through.
export function sandboxEnvBindings(env: Env): Record<string, string> {
  const raw = env as unknown as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const key of Object.keys(raw)) {
    if (SANDBOX_BLOCKED_ENV_KEYS.has(key)) continue
    if (typeof raw[key] === 'string') out[key] = raw[key]
  }
  return out
}

// Assemble the env handed to a code-node sandbox: worker bindings (minus master
// secrets) overlaid with the org's loaded env vars. `ctxEnv` comes from
// env-loader, which DECRYPTS secret values before they get here — so a credential
// a node reads is the usable plaintext, never the encrypted blob. ctxEnv wins on
// key collision. Centralized (was duplicated inline in code.ts + index.ts) so the
// merge has one definition and a regression test: a wrong value assembled here is
// what broke Equifax on 2026-06-26 (the node received an encrypted secret).
export function buildSandboxEnv(env: Env, ctxEnv: Record<string, string>): Record<string, string> {
  return { ...sandboxEnvBindings(env), ...ctxEnv }
}
