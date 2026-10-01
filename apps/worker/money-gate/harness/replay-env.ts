/**
 * The Worker environment the money gate runs the engine with (#1704).
 *
 * Bindings (KV, Durable Objects) are the real ones the Vitest plugin builds from
 * the engine under test's wrangler.toml. The public [vars] come from that same
 * file, so a changed var is a change the gate sees. Every secret is a placeholder
 * (a URL shaped one on a reserved .invalid host), the dispatch namespace is the
 * recording fake, and the local development switches are removed so no guard
 * behaves as it would on a laptop.
 */
import { placeholderValue } from '../lib/snapshot'

/** 2026-10-01 15:00:00 UTC, a weekday afternoon in US Eastern business hours. */
export const FIXED_TIME_MS = Date.UTC(2026, 9, 1, 15, 0, 0)

export interface Variant {
  name: string
  /** What arm this fixture is meant to reach, for the reader. */
  purpose?: string
  source?: string
  set?: Record<string, unknown>
  unset?: string[]
  /** Stub rule name to scenario name. */
  stubs?: Record<string, string>
  /** Environment variable values this fixture runs with (a setting that gates an arm). */
  env?: Record<string, string>
  /** Runs of the same payload before the recorded one, whose state it meets (a repeat click). */
  prior_runs?: number
  /** Stub scenarios for the prior runs; the variant's own stubs when absent. */
  prior_stubs?: Record<string, string>
}

export interface VariantFile {
  workflow_id: string
  workflow_name: string
  /** Applied under every variant: a variant's own set, unset and stubs win. */
  common?: Omit<Variant, 'name' | 'purpose'>
  variants: Variant[]
}

/** A variant with its file's common part folded in. */
export function resolveVariant(file: VariantFile | undefined, v: Variant): Variant {
  const c = file?.common ?? {}
  return {
    ...v,
    source: v.source ?? c.source,
    set: { ...(c.set ?? {}), ...(v.set ?? {}) },
    unset: [...(c.unset ?? []), ...(v.unset ?? [])],
    stubs: { ...(c.stubs ?? {}), ...(v.stubs ?? {}) },
    env: { ...(c.env ?? {}), ...(v.env ?? {}) },
    prior_stubs: v.prior_stubs ? { ...(c.stubs ?? {}), ...v.prior_stubs } : undefined,
  }
}

/** The [vars] in wrangler.toml: public configuration, taken from the engine under test. */
const PUBLIC_VARS = ['SUPABASE_JWKS_URL', 'PII_REDACTION_FIELDS', 'APP_URL', 'GITHUB_REPO', 'GITHUB_CODE_REPO', 'SELF_CHECK_URL', 'PARTNER_PROBE_ALERTS']

/** Worker secrets the engine or a code node reads. A name a definition reads is added on top. */
const SECRET_NAMES = [
  'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'API_KEY_MAP', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID',
  'SSN_HASH_PEPPER', 'SALESFORCE_INSTANCE_URL', 'SALESFORCE_CLIENT_ID', 'SALESFORCE_CLIENT_SECRET',
  'EQUIFAX_USERNAME', 'EQUIFAX_PASSWORD', 'EQ_USER', 'EQ_PASS', 'TRIPOINT_PROXY_SECRET',
  'ACHIEVE_USERNAME', 'ACHIEVE_PASSWORD', 'ACHIEVE_API_URL', 'ACHIEVE_PARTNER_KEY', 'SCOUT_KEY',
]

/** 32 zero bytes, base64: a valid AES-GCM key that protects nothing. */
const TEST_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

const DEV_SWITCHES = ['LOCAL_DEV', 'ALLOW_PROD_WRITES', 'SECRET_ENCRYPTION_KEY_NEXT']

export function envNamesReadBy(definition: unknown): string[] {
  const text = JSON.stringify(definition)
  return [...new Set([...text.matchAll(/env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))].sort()
}

/** `partnerSecrets` are the Worker secret names partner configs read their credential from (cf_secret_key). */
export function buildEnv(testEnv: Record<string, unknown>, loader: unknown, def: { definition: unknown }, partnerSecrets: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(testEnv)) {
    if (k === 'GATE_IO' || k === 'DYNAMIC_WORKER_LOADER') continue
    if (typeof v !== 'string') out[k] = v
  }
  for (const k of PUBLIC_VARS) if (typeof testEnv[k] === 'string') out[k] = testEnv[k]
  for (const k of [...SECRET_NAMES, ...partnerSecrets, ...envNamesReadBy(def.definition)]) if (!(k in out)) out[k] = placeholderValue(k)
  out.API_KEY_MAP = '{}'
  out.SECRET_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY
  for (const k of DEV_SWITCHES) delete out[k]
  out.DYNAMIC_WORKER_LOADER = loader
  return out
}
