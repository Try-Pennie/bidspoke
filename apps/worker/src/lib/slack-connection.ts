/**
 * The Slack connection record, and the one place its stored config is turned
 * into one (#1297).
 *
 * `getSlackConnection` in slack.ts reads the row and hands it here. The
 * database probe keeps an encrypted last-good copy of every org's connection
 * in KV so alerts can post while the database is unreachable, and it reads the
 * same rows through this module, so the readers cannot drift (L370). Kept in
 * its own module so a test that mocks slack.ts still gets the real parser.
 *
 * The token's home (#2331, phase 1 of #1689). Until #2331 the bot token sat in
 * config.bot_token in plain text, and the browser roles could read the table.
 * It is now sealed into service_connections.credential_enc with the Worker's
 * key ring, and every reader of a ROW goes through resolveSlackConnection,
 * which opens the ciphertext first. In this release config.bot_token is still
 * written beside it (dual write), because the code before this release, the
 * rollback target, reads only that (L640), and the resolver falls back to it
 * when the ciphertext is absent or cannot be opened. A fallback over a
 * ciphertext that will not open is returned WITH its problem, which every
 * caller logs by name, and the minute probe pages (slack-token-health.ts), so
 * a bad seal cannot hide behind the plaintext until the contract release
 * strips it (F128). parseSlackConnection stays for what is not a row: the
 * saved copy's entries, which hold the token inside the encrypted copy.
 *
 * Which row is the alert row (#2332) is defined here too, once
 * (onlySlackAlertRow), for every reader in lib and in routes/api.
 */
import { decryptSecret, type SecretKeyInput } from './secret-crypto'
import { formatErr } from './format-error'

export interface SlackConnection {
  bot_token: string
  default_channel: string
  workspace_name?: string
  volume_alerts_enabled: boolean
  matrix_alerts_enabled: boolean
  config_alerts_enabled: boolean
  /** GitHub workflow-backup-failure alerts (#206). Own toggle so muting config
   *  noise doesn't silently disable this data-safety alert (#223). */
  backup_alerts_enabled: boolean
  /** Optional dedicated channel for matrix-change alerts. Falls back to default_channel when null. */
  matrix_alerts_channel: string | null
}

/** Null when the config lacks a bot token or a default channel. */
export function parseSlackConnection(config: unknown): SlackConnection | null {
  if (!config || typeof config !== 'object') return null
  const cfg = config as Record<string, unknown>
  const botToken = typeof cfg.bot_token === 'string' ? cfg.bot_token : null
  const defaultChannel = typeof cfg.default_channel === 'string' ? cfg.default_channel : null
  if (!botToken || !defaultChannel) return null
  return {
    bot_token: botToken,
    default_channel: defaultChannel,
    workspace_name: typeof cfg.workspace_name === 'string' ? cfg.workspace_name : undefined,
    // Default true so existing connections keep alerting; opt-out only.
    volume_alerts_enabled: cfg.volume_alerts_enabled !== false,
    matrix_alerts_enabled: cfg.matrix_alerts_enabled !== false,
    config_alerts_enabled: cfg.config_alerts_enabled !== false,
    backup_alerts_enabled: cfg.backup_alerts_enabled !== false,
    matrix_alerts_channel: typeof cfg.matrix_alerts_channel === 'string' && cfg.matrix_alerts_channel ? cfg.matrix_alerts_channel : null,
  }
}

/** The columns a Slack connection row is resolved from; every reader selects both. */
export const SLACK_ROW_COLUMNS = 'config, credential_enc'

// ── The alert row (#2332, phase 2 of #1689) ─────────────────────────────────
//
// An organization can hold more than one Slack row since release 2 dropped the
// old UNIQUE (organization_id, service_type) (migration 20261019150000): an ops connection (sealed_for
// 'ops_key', its own name and bot, #1689 Phase 8) beside the alert bot's row.
// Every alert reader and writer reads only the ALERT row, through the one
// filter below, so an ops row can never be read as the alert row and post an
// alert with the ops bot.
//
// The alert row is service_type 'slack', name 'slack' (what migration
// 20261017150000 backfilled; no ops_key slack row may take it,
// service_connections_alert_name_reserved), and sealed_for 'bidding_ring' or
// null. Null is the legacy unsealed form: the production row has it until
// POST /api/admin/seal-slack-token seals it (measured 2026-10-17: the one row
// has sealed_for null and no credential_enc). The contract release of #2331,
// once every row is sealed, is where the null disjunct can go.
//
// More than one candidate is its own named refusal (SLACK_ALERT_AMBIGUOUS),
// never "no Slack" and never one of them picked (L55, L1005). UNIQUE
// (organization_id, service_type, name) makes it impossible today, and the
// partial unique index service_connections_one_alert_row makes two sealed
// alert rows impossible, but a reader that picked one would
// hide the day a constraint changes. Each reader asks for
// SLACK_ALERT_READ_LIMIT rows, enough to tell one from several, rather than
// `.maybeSingle()`: its more than one row error reads, on the scheduled
// client, as the database failing, which would send every lookup in the tick
// to the saved copy and report an outage that is not one.

/** The alert row's name: what migration 20261017150000 backfilled, and reserved from ops rows. */
export const SLACK_ALERT_CONNECTION_NAME = 'slack'

/** The named refusal for more than one alert row candidate. */
export const SLACK_ALERT_AMBIGUOUS = 'slack_alert_connection_ambiguous'

/** Rows a one organization read asks for: enough to tell one alert row from several. */
export const SLACK_ALERT_READ_LIMIT = 2

/** The PostgREST filter for an alert row, in the shape the client sends (sealed_for bidding_ring, or legacy unsealed). */
export const SLACK_ALERT_SEAL_FILTER = 'sealed_for.eq.bidding_ring,sealed_for.is.null'

/** The filter methods onlySlackAlertRow calls, which every supabase-js filter builder has, each returning the builder. */
interface AlertRowFilterable {
  eq(column: 'service_type' | 'name', value: string): AlertRowFilterable
  or(filters: string): AlertRowFilterable
}

/**
 * Narrow a service_connections read to the alert row: the one place the alert
 * row is defined. The builder comes back as the same type it went in as (each
 * filter returns the builder itself); the constraint is kept shallow because
 * matching supabase-js's generic filter signatures recursively is more than
 * the compiler will instantiate (TS2589).
 */
export function onlySlackAlertRow<Q extends { eq: unknown; or: unknown }>(query: Q): Q {
  const filterable = query as unknown as AlertRowFilterable
  return filterable.eq('service_type', 'slack').eq('name', SLACK_ALERT_CONNECTION_NAME).or(SLACK_ALERT_SEAL_FILTER) as unknown as Q
}

/** What a one organization read of the alert row found. */
export type SlackAlertRowPick<R> = { kind: 'row'; row: R | null } | { kind: 'ambiguous'; count: number }

/** The one alert row of a one organization read, null for none, or ambiguous for more than one. */
export function pickSlackAlertRow<R>(rows: readonly R[] | null | undefined): SlackAlertRowPick<R> {
  const found = rows ?? []
  if (found.length > 1) return { kind: 'ambiguous', count: found.length }
  return { kind: 'row', row: found[0] ?? null }
}

/** An all organization read split into the organizations with exactly one alert row, and those with several. */
export function slackAlertRowsByOrg<R extends { organization_id: string }>(rows: readonly R[]): { rows: R[]; ambiguousOrgs: string[] } {
  const byOrg = new Map<string, R[]>()
  for (const row of rows) {
    const list = byOrg.get(row.organization_id)
    if (list) list.push(row)
    else byOrg.set(row.organization_id, [row])
  }
  const single: R[] = []
  const ambiguousOrgs: string[] = []
  for (const [orgId, list] of byOrg) {
    if (list.length === 1) single.push(list[0])
    else ambiguousOrgs.push(orgId)
  }
  return { rows: single, ambiguousOrgs }
}

/** The one log line for an organization with more than one alert row candidate, so every reader says it the same way. */
export function slackAlertAmbiguityLine(subject: string, count: number | null): string {
  const how = count === null ? 'more than one' : String(count)
  return `[slack] ${subject}: ${SLACK_ALERT_AMBIGUOUS}: ${how} rows match the Slack alert connection (service_type slack, name slack, sealed for bidding_ring or unsealed), so none of them was used`
}

/** A Slack connection row as read: its config, and its sealed token when it has one. */
export interface SlackConnectionRow {
  config?: unknown
  credential_enc?: string | null
}

/**
 * Why a sealed token could not be read. `slack_token_undecryptable`: no key in
 * the ring opens the ciphertext (a key rotated away, a row never relocked, a
 * damaged value). `slack_key_ring_missing`: the reader was given no ring at all,
 * which is a wiring defect (a client built outside createSupabaseClient).
 */
export type SlackTokenProblem = 'slack_token_undecryptable' | 'slack_key_ring_missing'

/**
 * What a row resolved to. `connection` may carry a `problem`: the ciphertext
 * would not open and the plaintext copy stood in, which works today and is a
 * defect the contract release would turn into silence, so it is said. `none` is
 * the row (or its absence) saying there is no usable connection, as before.
 * `unreadable` is a sealed token nobody can read and no plaintext to stand in:
 * never `none`, since the org does have Slack (L11).
 */
export type SlackRowResolution =
  | { kind: 'connection'; connection: SlackConnection; source: 'sealed' | 'plaintext'; problem?: { reason: SlackTokenProblem; detail: string } }
  | { kind: 'none' }
  | { kind: 'unreadable'; reason: SlackTokenProblem; detail: string }

/**
 * Turn a row into a Slack connection: the sealed token first, the plaintext copy
 * only as a fallback (#2331). Never throws, and never puts the token or the
 * ciphertext into what it says.
 */
export async function resolveSlackConnection(
  row: SlackConnectionRow | null | undefined,
  keys: SecretKeyInput | undefined,
): Promise<SlackRowResolution> {
  if (!row) return { kind: 'none' }
  const ciphertext = typeof row.credential_enc === 'string' && row.credential_enc.length > 0 ? row.credential_enc : null
  if (!ciphertext) {
    const connection = parseSlackConnection(row.config)
    return connection ? { kind: 'connection', connection, source: 'plaintext' } : { kind: 'none' }
  }
  let problem: { reason: SlackTokenProblem; detail: string }
  if (!keys) {
    problem = { reason: 'slack_key_ring_missing', detail: 'the reader was given no key ring for a sealed token' }
  } else {
    try {
      const token = await decryptSecret(ciphertext, keys)
      const base = row.config && typeof row.config === 'object' ? (row.config as Record<string, unknown>) : {}
      const connection = parseSlackConnection({ ...base, bot_token: token })
      return connection ? { kind: 'connection', connection, source: 'sealed' } : { kind: 'none' }
    } catch (e) {
      problem = { reason: 'slack_token_undecryptable', detail: `no key in the ring opens credential_enc (${formatErr(e)})` }
    }
  }
  const fallback = parseSlackConnection(row.config)
  if (fallback) return { kind: 'connection', connection: fallback, source: 'plaintext', problem }
  return { kind: 'unreadable', ...problem }
}

/** The one log line for a row whose sealed token could not be read, so every reader says it the same way. */
export function slackTokenProblemLine(subject: string, problem: { reason: SlackTokenProblem; detail: string }, fellBackToPlaintext: boolean): string {
  const what = fellBackToPlaintext
    ? 'the plaintext copy in config.bot_token was used instead, which the contract release removes'
    : 'there is no plaintext copy, so this connection cannot be used'
  return `[slack] ${subject}: ${problem.reason}: ${problem.detail}; ${what}`
}
