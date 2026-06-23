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
const ENV_SANDBOX_POLICY: Record<EnvStringKey, 'block' | 'expose'> = {
  // Master secrets and sensitive credentials — never exposed.
  SUPABASE_SECRET_KEY: 'block',
  API_KEY_MAP: 'block',
  CLOUDFLARE_API_TOKEN: 'block',
  CLOUDFLARE_ACCOUNT_ID: 'block',
  SECRET_ENCRYPTION_KEY: 'block',
  SSN_HASH_PEPPER: 'block',
  SNOWFLAKE_ACCOUNT: 'block',
  SNOWFLAKE_USER: 'block',
  SNOWFLAKE_PRIVATE_KEY: 'block',
  SNOWFLAKE_DATABASE: 'block',
  SNOWFLAKE_SCHEMA: 'block',
  SNOWFLAKE_WAREHOUSE: 'block',
  SNOWFLAKE_ROLE: 'block',
  GITHUB_TOKEN: 'block',
  ANTHROPIC_API_KEY: 'block',
  // Non-secret config — safe to expose.
  SUPABASE_URL: 'expose',
  SUPABASE_PUBLISHABLE_KEY: 'expose',
  SUPABASE_JWKS_URL: 'expose',
  PII_REDACTION_FIELDS: 'expose',
  APP_URL: 'expose',
  SELF_CHECK_URL: 'expose',
  GITHUB_REPO: 'expose',
  DEPLOYED_SHA: 'expose', // non-secret: the live worker's git commit (#327)
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
