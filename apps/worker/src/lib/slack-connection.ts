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
