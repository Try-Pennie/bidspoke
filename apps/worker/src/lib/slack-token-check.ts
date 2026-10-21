/**
 * Asking Slack whether a bot token works (#2331, #2338): auth.test through the
 * one client (@bidspoke/slack-client). Two callers share it, so they cannot
 * disagree about what counts as a refusal (L370):
 *
 * - POST /api/integrations/slack checks a token before it is sealed and saved;
 * - GET /api/connections checks the Slack alert login's stored token, so the
 *   Connections page shows a status that was measured (build PR 9) rather
 *   than none, which is all ops health could give it, since ops never holds
 *   that login.
 *
 * `ok` for a token Slack accepts, with who the bot is (its user and its team,
 * as auth.test names them, null where Slack left one out); `refused` with
 * Slack's code for one it rejects. Anything that is not an answer about the
 * token (a 429, a 5xx, a body that is not JSON, no answer at all) throws, so a
 * token Slack could not be asked about is never called invalid. A 429 is never
 * waited for.
 */
import { createSlackClient, slackCallFailure, slackNetworkCause } from '@bidspoke/slack-client'

export type SlackTokenCheck =
  | { kind: 'ok'; user: string | null; team: string | null }
  | { kind: 'refused'; slackError: string | null }

const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

export async function verifySlackToken(token: string): Promise<SlackTokenCheck> {
  try {
    const answer = await createSlackClient({ bot_token: token }).auth.test()
    // The library throws only for ok:false WITH a code; without one it returns.
    if (answer.ok) return { kind: 'ok', user: textOrNull(answer.user), team: textOrNull(answer.team) }
    return { kind: 'refused', slackError: answer.error ?? null }
  } catch (e) {
    const failure = slackCallFailure(e)
    if (failure?.kind === 'api') return { kind: 'refused', slackError: failure.error }
    if (failure?.kind === 'http') {
      throw new Error(`auth.test answered HTTP ${failure.status}${failure.retryAfter ? ` (Retry-After ${failure.retryAfter} s, not waited for)` : ''}, so the token could not be checked`, { cause: e })
    }
    throw slackNetworkCause(e)
  }
}

/** Who a bot is, as the Connections page's Acts as reads it: "<bot> in <workspace>", or what Slack named of the two. */
export function slackActsAs(check: { user: string | null; team: string | null }): string | null {
  if (check.user && check.team) return `${check.user} in ${check.team}`
  return check.user ?? check.team
}
