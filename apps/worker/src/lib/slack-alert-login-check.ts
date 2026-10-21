/**
 * The Slack alert login's status on the Connections page (#2338, build PR 9).
 *
 * Ops health never checks this login (ops never holds it), so without this the
 * page could only draw it with no status, and the settled design draws it
 * Working, which nothing would have measured. So the list route asks Slack
 * itself, with the token check POST /api/integrations/slack uses before a save
 * (verifySlackToken, lib/slack-token-check.ts), inside the same deadline the
 * list gives ops health, and maps Slack's answer onto the page's one status
 * vocabulary (@bidspoke/service-catalogue):
 *
 *   Slack accepts the token        ok (Working), acting as the bot Slack names
 *   Slack refuses it               reauth (Needs reconnecting): only a new token fixes it
 *   a sealed token no key opens  reauth too, and Slack is not asked: the alerts cannot
 *   (and no plaintext copy)       post with it either, and saving the token again is the fix
 *   a row with no usable token    unanswered: nothing about a token was measured
 *   no answer by the deadline      unanswered: the route shows the last known status
 *                                  under the stale strip, as for an ops login, or no
 *                                  status when none is stored (never a made up one)
 *
 * The token is read through the one alert row filter and resolver
 * (lib/slack-connection.ts) and goes nowhere but auth.test; nothing here logs
 * or answers it.
 */
import type { ConnectionPageStatus } from '@bidspoke/service-catalogue/schema'
import { pickSlackAlertRow, resolveSlackConnection, SLACK_ALERT_CONNECTION_NAME, slackAlertAmbiguityLine, type SlackConnectionRow } from './slack-connection'
import { secretKeys, type SecretKeys } from './secret-crypto'
import { slackActsAs, verifySlackToken } from './slack-token-check'
import { formatErr } from './format-error'

export type SlackAlertLoginCheck =
  | { kind: 'answered'; status: ConnectionPageStatus; acts_as: string | null }
  | { kind: 'unanswered'; detail: string }

/** The alert row among listed rows: service slack, named slack, sealed for bidding_ring or the legacy unsealed form (onlySlackAlertRow's rule). */
export function isSlackAlertRow(row: { service_type: string; name: string; sealed_for: string | null }): boolean {
  return row.service_type === 'slack' && row.name === SLACK_ALERT_CONNECTION_NAME && (row.sealed_for === 'bidding_ring' || row.sealed_for === null)
}

/** Resolves to `undefined` once `ms` have passed; the timer is cleared by `done`. */
function deadline(ms: number): { reached: Promise<undefined>; done: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  const reached = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms) })
  return { reached, done: () => { if (timer !== null) clearTimeout(timer) } }
}

/**
 * `readRow` reads the organization's alert row's token columns (the route
 * passes its read through onlySlackAlertRow, SLACK_ROW_COLUMNS, at most
 * SLACK_ALERT_READ_LIMIT rows), so the table stays read only in its homes.
 */
export async function checkSlackAlertLogin(
  readRow: () => PromiseLike<{ data: unknown; error: unknown }>,
  env: { SECRET_ENCRYPTION_KEY: string; SECRET_ENCRYPTION_KEY_NEXT?: string },
  orgId: string,
  deadlineMs: number,
): Promise<SlackAlertLoginCheck> {
  const limit = deadline(deadlineMs)
  try {
    const asked = (async (): Promise<SlackAlertLoginCheck> => {
      const { data, error } = await readRow()
      if (error) return { kind: 'unanswered', detail: `the alert login's token could not be read: ${formatErr(error)}` }
      const picked = pickSlackAlertRow(data as unknown as SlackConnectionRow[] | null)
      if (picked.kind === 'ambiguous') {
        console.error(slackAlertAmbiguityLine(`connections list for org ${orgId}`, picked.count))
        return { kind: 'unanswered', detail: 'more than one Slack alert row' }
      }
      let keys: SecretKeys | undefined
      try {
        keys = secretKeys(env)
      } catch {
        keys = undefined
      }
      const resolved = await resolveSlackConnection(picked.row, keys)
      // Only a sealed token no key opens, with no plaintext copy, is known to be
      // unusable. A row that reads as no connection (no token, no channel, or
      // gone since the list read) measured nothing about a token, so it is not
      // called refused: it falls back to the last known status like no answer.
      if (resolved.kind === 'unreadable') {
        console.error(JSON.stringify({ event: 'slack_alert_login_unreadable', organization_id: orgId, reason: resolved.reason }))
        return { kind: 'answered', status: 'reauth', acts_as: null }
      }
      if (resolved.kind !== 'connection') {
        console.warn(JSON.stringify({ event: 'slack_alert_login_unchecked', organization_id: orgId, reason: picked.row ? 'no_usable_token' : 'row_gone' }))
        return { kind: 'unanswered', detail: picked.row ? 'the alert row holds no usable token and channel' : 'the alert row is gone' }
      }
      const check = await verifySlackToken(resolved.connection.bot_token)
      if (check.kind === 'refused') {
        console.warn(JSON.stringify({ event: 'slack_alert_login_refused', organization_id: orgId, slack_error: check.slackError }))
        return { kind: 'answered', status: 'reauth', acts_as: null }
      }
      return { kind: 'answered', status: 'ok', acts_as: slackActsAs(check) }
    })().catch((err: unknown): SlackAlertLoginCheck => ({ kind: 'unanswered', detail: formatErr(err) }))
    const answer = await Promise.race([asked, limit.reached])
    return answer ?? { kind: 'unanswered', detail: `Slack did not answer within ${Math.round(deadlineMs / 1000)} s` }
  } finally {
    limit.done()
  }
}
