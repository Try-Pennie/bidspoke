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
 *   the stored token cannot be read reauth too, and Slack is not asked: the alerts cannot
 *                                  post with it either, and saving the token again is the fix
 *   no answer by the deadline      unanswered: the route shows the last known status
 *                                  under the stale strip, as for an ops login, or no
 *                                  status when none is stored (never a made up one)
 *
 * The token is read through the one alert row filter and resolver
 * (lib/slack-connection.ts) and goes nowhere but auth.test; nothing here logs
 * or answers it.
 */
import type { ConnectionPageStatus } from '@bidspoke/service-catalogue/schema'
import type { createSupabaseClient } from './supabase'
import { onlySlackAlertRow, pickSlackAlertRow, resolveSlackConnection, SLACK_ALERT_CONNECTION_NAME, SLACK_ALERT_READ_LIMIT, SLACK_ROW_COLUMNS, slackAlertAmbiguityLine, type SlackConnectionRow } from './slack-connection'
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

type Supabase = ReturnType<typeof createSupabaseClient>

/** Resolves to `undefined` once `ms` have passed; the timer is cleared by `done`. */
function deadline(ms: number): { reached: Promise<undefined>; done: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  const reached = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms) })
  return { reached, done: () => { if (timer !== null) clearTimeout(timer) } }
}

export async function checkSlackAlertLogin(
  supabase: Supabase,
  env: { SECRET_ENCRYPTION_KEY: string; SECRET_ENCRYPTION_KEY_NEXT?: string },
  orgId: string,
  deadlineMs: number,
): Promise<SlackAlertLoginCheck> {
  const limit = deadline(deadlineMs)
  try {
    const asked = (async (): Promise<SlackAlertLoginCheck> => {
      const { data, error } = await onlySlackAlertRow(supabase.from('service_connections').select(SLACK_ROW_COLUMNS).eq('organization_id', orgId)).limit(SLACK_ALERT_READ_LIMIT)
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
      if (resolved.kind !== 'connection') {
        console.error(JSON.stringify({ event: 'slack_alert_login_unreadable', organization_id: orgId, reason: resolved.kind === 'unreadable' ? resolved.reason : 'no_token' }))
        return { kind: 'answered', status: 'reauth', acts_as: null }
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
