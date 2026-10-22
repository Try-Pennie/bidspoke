/**
 * Whether an ops Slack connection's bot is the alerts bot (#2337, Dan's
 * decision 6: the ops Slack bot is a separate Slack app's, never the bot that
 * posts Bidspoke's alerts).
 *
 * Ops verify measures what an ops Slack token authenticates as (auth.test's
 * bot_id, ops/connections/slack-service.ts), but ops never holds the alerts
 * login, so it cannot compare. The bidding Worker holds it: this reads the
 * organization's alert row through the one alert row filter and resolver
 * (lib/slack-connection.ts), asks Slack who the alerts token is with the same
 * auth.test every alert login check uses (verifySlackToken), and compares the
 * two bots. The create and Reconnect routes call it after verify passes, so a
 * save of the alerts token as an ops connection is refused by name
 * (connection_money_identity, slack_alert_bot).
 *
 *   alert_bot   the same bot: refuse
 *   other       a different bot, or no alerts bot to be (no alert row, no token
 *               on it, or a token Slack refuses, which can post nothing)
 *   unreadable  it could not be told: the row could not be read or is
 *               ambiguous, its sealed token opens with no key, or Slack did not
 *               answer. The routes refuse the save, the harmless side (L648).
 *
 * Nothing here logs or answers the alerts token.
 */
import { secretKeys, type SecretKeys } from './secret-crypto'
import { pickSlackAlertRow, resolveSlackConnection, type SlackConnectionRow } from './slack-connection'
import { verifySlackToken } from './slack-token-check'

export type SlackAlertBotCheck = { kind: 'alert_bot' } | { kind: 'other' } | { kind: 'unreadable'; detail: string }

/**
 * `readRow` reads the organization's alert row's token columns, through
 * onlySlackAlertRow and SLACK_ROW_COLUMNS, at most SLACK_ALERT_READ_LIMIT rows.
 */
export async function compareWithSlackAlertBot(
  readRow: () => PromiseLike<{ data: unknown; error: unknown }>,
  env: { SECRET_ENCRYPTION_KEY: string; SECRET_ENCRYPTION_KEY_NEXT?: string },
  orgId: string,
  measuredBotId: string,
): Promise<SlackAlertBotCheck> {
  let read: { data: unknown; error: unknown }
  try {
    read = await readRow()
  } catch {
    read = { data: null, error: true }
  }
  const { data, error } = read
  if (error) return { kind: 'unreadable', detail: 'the alert login could not be read' }
  const picked = pickSlackAlertRow(data as SlackConnectionRow[] | null)
  if (picked.kind === 'ambiguous') return { kind: 'unreadable', detail: `the organization holds ${picked.count} Slack alert rows` }
  let keys: SecretKeys | undefined
  try {
    keys = secretKeys(env)
  } catch {
    keys = undefined
  }
  const resolved = await resolveSlackConnection(picked.row, keys)
  if (resolved.kind === 'unreadable') return { kind: 'unreadable', detail: `the alert login's token could not be opened (${resolved.reason})` }
  if (resolved.kind !== 'connection') return { kind: 'other' }
  let check: Awaited<ReturnType<typeof verifySlackToken>>
  try {
    check = await verifySlackToken(resolved.connection.bot_token)
  } catch (err) {
    // The error's text could carry anything Slack or the network said: its class only.
    console.error(JSON.stringify({ event: 'slack_alert_bot_unchecked', organization_id: orgId, error: err instanceof Error ? err.name : typeof err }))
    return { kind: 'unreadable', detail: 'Slack did not answer who the alerts bot is' }
  }
  if (check.kind === 'refused') return { kind: 'other' }
  return check.botId !== null && check.botId === measuredBotId ? { kind: 'alert_bot' } : { kind: 'other' }
}

