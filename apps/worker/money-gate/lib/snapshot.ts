/**
 * The config snapshot the money gate's Supabase double serves (#1704).
 *
 * It keeps the real STRUCTURE (which partners exist, which resolver each uses,
 * which tiers, which states a buyer takes) so the fixtures walk the paths
 * production walks, and replaces every number with a synthetic one. A
 * differential gate needs arms exercised, not real prices, so no partner price,
 * cap or threshold is committed.
 *
 * The synthetic number keeps only the order of magnitude and the position in its
 * array: n becomes sign(n) * 10^floor(log10|n|) * (index + 1). Ascending tiers
 * stay ascending and a threshold stays a threshold of the same size, which is
 * what the arm variants are written against.
 */
import { CREDENTIAL_NAME } from './redact'

function synth(n: number, index: number): number {
  if (n === 0 || !Number.isFinite(n)) return n
  const mag = Math.floor(Math.log10(Math.abs(n)))
  const unit = mag >= 0 ? 10 ** mag : 1 / 10 ** -mag
  const v = Math.sign(n) * unit * (index + 1)
  // Snap to the precision of the unit so 0.001 * 3 does not print as 0.0030000000000000005.
  return mag >= 0 ? v : Number(v.toFixed(-mag))
}

/**
 * A webhook URL often carries its credential in the path (a hook id, a trigger
 * token). Any path or query segment that looks like one (16 or more characters
 * mixing letters and digits) is replaced; the host and a plain path such as
 * /leads/create stay, because the stub rules answer by them.
 */
function redactUrlTokens(s: string): string {
  if (!/^https?:\/\//i.test(s)) return s
  return s.replace(/([/=?&])([A-Za-z0-9_-]{16,})(?=$|[/?&#])/g, (m, sep: string, seg: string) =>
    /[A-Za-z]/.test(seg) && /\d/.test(seg) ? `${sep}placeholder-token` : m)
}

export function synthesizeNumbers(value: unknown, index = 0): unknown {
  if (typeof value === 'number') return synth(value, index)
  if (typeof value === 'string') return redactUrlTokens(value)
  if (Array.isArray(value)) return value.map((v, i) => synthesizeNumbers(v, i))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = synthesizeNumbers(v, index)
    return out
  }
  return value
}

/** Who edited a row and what a live probe last saw describe people and traffic, not structure. */
const DROPPED = new Set(['updated_by', 'updated_by_email', 'updated_by_name', 'created_by', 'last_probe_response'])

/**
 * Numbers that are codes or an order, not prices, caps or thresholds: a partner's
 * result codes decide accepted from declined, a routing code names a buyer in
 * Salesforce, and priority ranks buyers. Synthesizing them would change WHICH arm a
 * lead takes, not how much it is worth, so they are kept as they are.
 */
const STRUCTURE_KEYS = new Set(['response_classification', 'accept_signals', 'duplicate_signals', 'external_routing_code', 'priority', 'version', 'extra_extraction', 'outbound_field_mapping'])

function stripAndSynthesize(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (DROPPED.has(k)) continue
    out[k] = STRUCTURE_KEYS.has(k) ? v : synthesizeNumbers(v)
  }
  return out
}

export function snapshotPartnerConfig(row: Record<string, unknown>): Record<string, unknown> {
  return stripAndSynthesize(row)
}

export function snapshotBuyerProfile(row: Record<string, unknown>): Record<string, unknown> {
  return stripAndSynthesize(row)
}

export function snapshotUuidMapRow(row: Record<string, unknown>): Record<string, unknown> {
  return stripAndSynthesize(row)
}

export interface EnvVarRow {
  key: string
  value: string | null
  is_secret: boolean
  scope: string
  organization_id: string
  workflow_id: string | null
}

/** A stand-in value a client can still parse: a URL shaped name gets a URL on a reserved host. */
export function placeholderValue(key: string): string {
  if (/(_URL|_ENDPOINT|_HOST)$/.test(key)) return `https://${key.toLowerCase().replace(/_/g, '-')}.placeholder.invalid`
  return `placeholder-${key}`
}

/**
 * The NAME of an environment variable is structure; a secret's value never leaves
 * production. A non secret setting can steer an arm (a score floor, a percent, a
 * mode), so a number is kept as a synthetic number and a short word (a mode, a
 * flag) as itself. Anything else is a placeholder.
 */
export function snapshotEnvVar(row: EnvVarRow): EnvVarRow {
  let value = placeholderValue(row.key)
  const raw = (row.value ?? '').trim()
  if (!row.is_secret && !/(_URL|_ENDPOINT|_HOST)$/.test(row.key) && !CREDENTIAL_NAME.test(row.key) && !/(USER|LOGIN|EMAIL)/i.test(row.key)) {
    if (/^-?\d+(\.\d+)?$/.test(raw)) value = String(synthesizeNumbers(Number(raw)))
    else if (/^[A-Za-z_][A-Za-z_-]{0,39}$/.test(raw)) value = raw
    else if (/^[A-Za-z]{1,12}(\s*,\s*[A-Za-z]{1,12})+$/.test(raw)) value = raw
  }
  return {
    key: row.key,
    value,
    is_secret: false,
    scope: row.scope,
    organization_id: row.organization_id,
    workflow_id: row.workflow_id,
  }
}

export interface ConfigSnapshot {
  version: 1
  exported_at: string
  /** Table name to rows, served by the Supabase double. */
  tables: Record<string, Array<Record<string, unknown>>>
}
