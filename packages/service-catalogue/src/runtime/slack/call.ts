import { createSlackClient, slackCallFailure, type SlackAPIClient } from '@bidspoke/slack-client'
import { ActionFailure } from '../failure'
import type { ActionContext } from '../types'

/**
 * How a catalogue Slack action talks to Slack (#2337): through the one Slack
 * client factory (@bidspoke/slack-client), bound to the step's connection
 * fetch, so the client has no retry handler and no debug logging, as every
 * alert's has, and every request goes through connectionFetch, which applies
 * the bot token and refuses any host but slack.com.
 *
 * A failure is read once, here, for every Slack action:
 *  - what the connection bound fetch throws for a request not yet answered (an
 *    expired or revoked login, a 429 turned into a requeue, a timeout) is
 *    passed on unchanged, for the executor to judge (runtime/failure.ts);
 *  - ok:false is `slack_<Slack's code>`, not applied; with no code it is
 *    `slack_refused_without_code`, never a null;
 *  - a 429 answered to the action is `slack_rate_limited`, not applied, its
 *    wait named; another 4xx is `slack_http_<status>`, not applied; a 5xx is
 *    `slack_http_<status>` with its outcome unknown, since Slack may have
 *    acted before it failed;
 *  - a 200 whose body cannot be read is `slack_answer_unreadable`, outcome
 *    unknown, since the call may have been applied.
 */

export function slackClientFor(ctx: ActionContext): SlackAPIClient {
  return createSlackClient({ fetch: ctx.fetch, signal: ctx.signal })
}

/** Runs one Slack call and reads its failure by name. */
export async function slackCall<T>(method: string, call: () => Promise<T>): Promise<T & { ok?: boolean; error?: string }> {
  let answer: T & { ok?: boolean; error?: string }
  try {
    answer = (await call()) as T & { ok?: boolean; error?: string }
  } catch (err) {
    const failure = slackCallFailure(err)
    if (failure?.kind === 'api') {
      throw new ActionFailure(`slack_${failure.error}`, `Slack refused ${method}: ${failure.error}`, 'not_applied')
    }
    if (failure?.kind === 'http') {
      if (failure.status === 429) {
        const wait = failure.retryAfter === null ? 'no Retry-After' : `Retry-After ${failure.retryAfter} s`
        throw new ActionFailure('slack_rate_limited', `Slack rate limited ${method} (${wait}); not sent`, 'not_applied')
      }
      const outcome = failure.status >= 500 ? 'unknown' : 'not_applied'
      throw new ActionFailure(`slack_http_${failure.status}`, `Slack answered ${method} with HTTP ${failure.status}`, outcome)
    }
    if (err instanceof SyntaxError) {
      throw new ActionFailure('slack_answer_unreadable', `Slack's answer to ${method} was not JSON, so whether it was applied is unknown`, 'unknown')
    }
    throw err
  }
  if (answer.ok !== true) {
    throw new ActionFailure('slack_refused_without_code', `Slack refused ${method} and named no error code`, 'not_applied')
  }
  return answer
}
