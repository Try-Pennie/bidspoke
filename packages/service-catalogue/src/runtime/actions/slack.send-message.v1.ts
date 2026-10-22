import { ActionFailure } from '../failure'
import { slackCall, slackClientFor } from '../slack/call'
import type { ActionRun, JsonValue } from '../types'

/**
 * slack.send-message, version 1 (#2337). Released: never edit it; a change is
 * version 2 (the fingerprint check refuses an edit).
 *
 * Parity with Pipedream's Send Message and Send Message to Channel (all five
 * components the workflows use post through PipedreamHQ/pipedream
 * components/slack_v2/actions/common/send-message.mjs, at commit b7d67916),
 * re-implemented, not copied: one chat.postMessage with the conversation, the
 * text and the settings the steps carry, returning Slack's answer as the
 * Pipedream action returned it. Where it differs, on purpose:
 *  - the text is sent as the message's text with `mrkdwn`, not wrapped in a
 *    section block, so a long message is not refused at a block's 3,000
 *    characters; and no "Sent via Pipedream" line is added;
 *  - "add the app to the channel" is not offered: Pipedream invited the bot
 *    with the person's user token, and an ops connection holds only the bot's,
 *    so a person invites the bot, and a post to a channel it is not in fails
 *    as `slack_not_in_channel`;
 *  - a 429 is never waited out inside the step (Pipedream retried three times,
 *    30 seconds apart): connectionFetch requeues the step.
 *  - scheduling (post_at), metadata, attachments and blocks are not offered:
 *    no step sets them.
 * A non string text is sent as JSON, as Pipedream did.
 */

const BOOLEAN_SETTINGS = ['reply_broadcast', 'mrkdwn', 'unfurl_links', 'unfurl_media'] as const
const TEXT_SETTINGS = ['thread_ts', 'username', 'icon_emoji'] as const

const invalid = (message: string) => new ActionFailure('slack_argument_invalid', message, 'not_applied')

export const run: ActionRun = async (ctx, args) => {
  const channel = args.channel
  if (typeof channel !== 'string' || channel.trim() === '') {
    throw new ActionFailure('slack_channel_missing', 'the step names no conversation to post to', 'not_applied')
  }
  const raw = args.text
  if (raw === undefined || raw === null || raw === '') {
    throw new ActionFailure('slack_text_missing', 'the step holds no text to post', 'not_applied')
  }
  const text = typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : JSON.stringify(raw)

  const settings: Record<string, string | boolean> = {}
  for (const key of BOOLEAN_SETTINGS) {
    const value = args[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'boolean') throw invalid(`${key} must be true or false`)
    settings[key] = value
  }
  for (const key of TEXT_SETTINGS) {
    const value = args[key]
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'string') throw invalid(`${key} must be text`)
    settings[key] = value
  }

  const answer = await slackCall('chat.postMessage', () => slackClientFor(ctx).chat.postMessage({ channel: channel.trim(), text, ...settings }))
  if (typeof answer.ts !== 'string' || typeof answer.channel !== 'string') {
    throw new ActionFailure('slack_answer_incomplete', 'Slack accepted the message and named no channel or ts for it', 'applied')
  }
  return { ok: true, channel: answer.channel, ts: answer.ts, message: (answer.message ?? null) as JsonValue }
}
