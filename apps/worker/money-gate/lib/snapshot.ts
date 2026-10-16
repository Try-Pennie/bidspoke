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

/**
 * The columns each config table may contribute, by allowlist: anything not listed
 * never reaches the snapshot, so a column added later (an editor's email, a free
 * text note or reason) stays in production until somebody decides it belongs here.
 * Who edited a row, what a live probe last saw and a blackout date's note are left
 * out on purpose. `synthesize` replaces numbers (prices, caps, thresholds) with
 * synthetic ones; operating hours and blackout dates are kept exactly, because they
 * are when a buyer takes leads, which the fixtures' fixed clock is judged against.
 */
export const SNAPSHOT_COLUMNS = {
  partner_configs: {
    synthesize: true,
    columns: [
      'id', 'organization_id', 'name', 'slug', 'partner_type', 'is_active', 'bid_resolver_type', 'bid_resolver_config',
      'bid_comparison_source', 'bid_formula', 'api_endpoint', 'cf_secret_key', 'daily_cap', 'min_bid', 'dedup_endpoint',
      'response_classification', 'alert_config', 'circuit_enabled', 'circuit_error_threshold', 'circuit_window_seconds',
      'circuit_cooldown_seconds', 'priority', 'sell_off_offer_title', 'sell_off_offer_details', 'click_url', 'outbound_field_mapping',
      'extra_extraction', 'confirmation_window_ms', 'sub_account_min_bids', 'accept_signals', 'duplicate_signals', 'external_routing_code',
    ],
  },
  buyer_profiles: {
    synthesize: true,
    columns: [
      'partner_id', 'organization_id', 'is_enabled', 'priority', 'allowed_states', 'debt_min', 'debt_max', 'loan_amount_min',
      'hourly_lead_cap', 'daily_lead_cap', 'hourly_spend_cap_cents', 'daily_spend_cap_cents', 'version', 'sold_on', 'click_delivery', 'updated_at',
    ],
  },
  partner_uuid_map: { synthesize: true, columns: ['id', 'org_id', 'partner_slug', 'uuid'] },
  buyer_pricing_tiers: { synthesize: true, columns: ['id', 'organization_id', 'partner_id', 'population', 'debt_from', 'debt_to', 'multiplier'] },
  buyer_operating_windows: { synthesize: false, columns: ['id', 'organization_id', 'partner_id', 'day_of_week', 'opens_minute', 'closes_minute'] },
  buyer_blackout_dates: { synthesize: false, columns: ['id', 'organization_id', 'partner_id', 'blackout_date'] },
} as const satisfies Record<string, { synthesize: boolean; columns: readonly string[] }>

export type SnapshotTable = keyof typeof SNAPSHOT_COLUMNS

/**
 * Numbers that are codes or an order, not prices, caps or thresholds: a partner's
 * result codes decide accepted from declined, a routing code names a buyer in
 * Salesforce, and priority ranks buyers. Synthesizing them would change WHICH arm a
 * lead takes, not how much it is worth, so they are kept as they are.
 */
const STRUCTURE_KEYS = new Set(['response_classification', 'accept_signals', 'duplicate_signals', 'external_routing_code', 'priority', 'version', 'extra_extraction', 'outbound_field_mapping'])

/** One config row as the snapshot holds it: listed columns only, numbers synthesized where the table says. */
export function snapshotRow(table: SnapshotTable, row: Record<string, unknown>): Record<string, unknown> {
  const spec = SNAPSHOT_COLUMNS[table]
  if (!spec) throw new Error(`money gate snapshot: no column allowlist for ${String(table)}`)
  const out: Record<string, unknown> = {}
  for (const k of spec.columns) {
    if (!(k in row)) continue
    const v = row[k]
    out[k] = !spec.synthesize || STRUCTURE_KEYS.has(k) ? v : synthesizeNumbers(v)
  }
  return out
}

export function snapshotPartnerConfig(row: Record<string, unknown>): Record<string, unknown> {
  return snapshotRow('partner_configs', row)
}

export function snapshotBuyerProfile(row: Record<string, unknown>): Record<string, unknown> {
  return snapshotRow('buyer_profiles', row)
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

/**
 * The updated_at every workflow row in the snapshot carries. Production rows
 * always have one (a trigger moves it on every update), and the definition
 * loader writes its stored outage copy (#1845) only from a row with a readable
 * stamp, so a row without one would leave the outage drill (#1305) no copy to
 * serve. A fixed value, because the real one says nothing the replay needs.
 */
export const SNAPSHOT_WORKFLOW_UPDATED_AT = '2026-01-01T00:00:00+00:00'

export interface ConfigSnapshot {
  version: 1
  exported_at: string
  /** Table name to rows, served by the Supabase double. */
  tables: Record<string, Array<Record<string, unknown>>>
}
