/**
 * The ops Slack service as OpsConnections uses it (#2337, phase 7 of #1689):
 * the ops Slack bot, a separate Slack app from the one that posts Bidspoke's
 * alerts (Dan's decision 6). Registered in services.ts.
 *
 * The login is `{ bot_token }` (the static key minter's slackBot placement,
 * minters/static-key.ts); the target is `{ team_id }`, the workspace the bot is
 * in. Every request goes to slack.com, the one host declared, and the token is
 * put on it by connectionFetch, never by the caller.
 *
 * THE EXPIRY SIGNAL. Slack refuses a login with HTTP 200 and `ok: false`
 * (invalid_auth, not_authed, token_revoked, token_expired, account_inactive),
 * not with a 401, so the static key minter's plain 401 would never see a
 * revoked token and the connection would never be marked as needing
 * reconnecting. The expiry signal here reads the body of a 200 for those codes
 * (and still takes a 401). connectionFetch then renews once, which reads the
 * same key again, and a second refusal is needs_reauth. A refused login was
 * never applied, so the one repeat cannot post a message twice.
 *
 * WHAT VERIFY MEASURES, AND WHY NOTHING IS RECORDED. auth.test, through the one
 * Slack client factory bound to connectionFetch (@bidspoke/slack-client), as
 * the catalogue's Slack action talks to Slack. It must answer a bot (a bot_id:
 * a person's token acts as that person) in the declared workspace, or verify
 * refuses it (verify_identity_mismatch). A different workspace needs a new
 * target, which is a new generation, so nothing is kept about it.
 *
 * What it cannot see: whether the bot is the alerts bot. Ops never holds the
 * alerts login, so the bidding Worker compares the measured bot against the
 * alerts bot when the connection is saved (lib/slack-alert-bot.ts).
 */
import { createSlackClient, slackCallFailure } from '@bidspoke/slack-client'
import { IdentityMismatch, IdentityUnreadable, type IdentityProbe } from './identity'
import { targetFields, targetString } from './minters/login-fields'
import { STATIC_KEY_PLACEMENTS, staticKeyAuth } from './minters/static-key'
import { ConnectionRefusal } from './refusals'
import type { OpsServiceEntry } from './ops-connections'
import type { AuthorizeInput } from './service-rules'

/** The one host an ops Slack connection reaches: the Web API's. */
export const SLACK_HOST = 'slack.com'

/** The Slack error codes that mean the login itself was refused. */
export const SLACK_LOGIN_REFUSALS: ReadonlySet<string> = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive'])

/** The workspace a target declares. Throws LoginMintError (not_allowed, target_invalid) when it declares none. */
export function slackTeamOf(target: unknown): string {
  return targetString(targetFields(target), 'team_id').trim()
}

async function slackExpired(response: Response): Promise<boolean> {
  if (response.status === 401) return true
  if (response.status !== 200) return false
  try {
    const body = (await response.json()) as { ok?: unknown; error?: unknown } | null
    return body !== null && body.ok === false && typeof body.error === 'string' && SLACK_LOGIN_REFUSALS.has(body.error)
  } catch {
    return false
  }
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

export const slackIdentity: IdentityProbe = {
  kind: 'slack',
  async measure(fetch, target) {
    let answer: Record<string, unknown>
    try {
      answer = (await createSlackClient({ fetch }).auth.test()) as unknown as Record<string, unknown>
    } catch (err) {
      if (err instanceof ConnectionRefusal) throw err
      // Its code or status only: never Slack's body.
      const failure = slackCallFailure(err)
      if (failure?.kind === 'api') throw new IdentityUnreadable(`auth.test refused the token (${failure.error})`)
      if (failure?.kind === 'http') throw new IdentityUnreadable(`auth.test answered HTTP ${failure.status}`)
      if (err instanceof SyntaxError) throw new IdentityUnreadable('auth.test answered a body that is not JSON')
      throw err
    }
    if (answer.ok !== true) throw new IdentityUnreadable('auth.test answered no ok')
    const teamId = text(answer.team_id)
    const userId = text(answer.user_id)
    if (teamId === null || userId === null) throw new IdentityUnreadable('auth.test named no team_id or no user_id')
    const botId = text(answer.bot_id)
    if (botId === null) throw new IdentityMismatch('the token is a person\'s, not a bot\'s: an ops Slack connection is a bot in a workspace')
    if (teamId !== slackTeamOf(target)) throw new IdentityMismatch('the bot is in another Slack workspace than its target declares')
    return { kind: 'slack', teamId, team: text(answer.team), userId, user: text(answer.user), botId }
  },
}

export function slackServiceEntry(): OpsServiceEntry {
  const key = staticKeyAuth(STATIC_KEY_PLACEMENTS.slackBot)
  return {
    rules: {
      service: 'slack',
      declaredHosts: (target) => {
        slackTeamOf(target)
        return [SLACK_HOST]
      },
      expired: slackExpired,
      // The target is read first, so a connection declaring no workspace is refused by rule before its key is read.
      authorize: (input: AuthorizeInput) => new Promise<void>((resolve) => {
        slackTeamOf(input.target)
        resolve()
      }).then(() => key.authorize(input)),
    },
    identity: slackIdentity,
  }
}
