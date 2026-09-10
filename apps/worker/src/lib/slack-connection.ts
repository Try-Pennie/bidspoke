/**
 * The Slack connection record, and the one place its stored config is turned
 * into one (#1297).
 *
 * `getSlackConnection` in slack.ts reads the row and hands the config here. The
 * volume cliff check keeps an encrypted last-good copy of every org's connection
 * in KV so it can post while the database is unreachable, and it parses the
 * same rows through this function, so the two readers cannot drift (L370).
 * Kept in its own module so a test that mocks slack.ts still gets the real
 * parser.
 */

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
