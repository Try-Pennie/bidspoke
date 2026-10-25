import type { ActionArgument, ActionSchema, ServiceSchema } from '../types'

/**
 * Slack (#2337, phase 7 of #1689): the ops Slack bot, a separate Slack app
 * from the one that posts Bidspoke's own alerts (Dan's decision 6), so an ops
 * step never holds the alerts token.
 *
 * WHAT THE PIPEDREAM WORKFLOWS USE, counted in the export of 2026-09-30 (the
 * duplicate project folder left out; steps inside an if/else branch counted,
 * since each is referenced by its workflow): 24 Slack action steps in 19
 * workflows. 23 post one message:
 *   slack_v2-send-message-to-channel  8 (0.1.0 x3, 0.1.3 x2 disabled, 0.1.4 x3)
 *   slack-send-message-to-channel     2 (0.0.4)
 *   slack_v2-send-message             5 (0.1.0, 4 of them disabled)
 *   slack-send-message                1 (0.0.19)
 *   slack_bot-send-message            7 (0.0.4 x1, 0.0.5 x6, 1 disabled)
 * All five post through chat.postMessage with the same settings (Pipedream's
 * components/slack_v2/actions/common/send-message.mjs; the channel type of
 * send-message is "informational only"), so they are this one action. No step
 * replies in a thread (none carries thread_ts), but the setting is offered, as
 * Pipedream offered it. The other step is slack_bot-upload-file 0.0.6 (one
 * step), which is not built here (its own issue). The 18 Slack triggers (new
 * keyword mention 16, new message in channels 2) are triggers, not actions.
 *
 * The connection is the bot's token (`{ bot_token }`, the ops static key
 * minter's slackBot placement) and the workspace it is a bot in (`team_id`),
 * which verify checks against Slack's auth.test.
 */

const optional = (key: string, parseJson: boolean): ActionArgument => ({ key, type: 'text', required: false, allowsVariables: true, parseJson })

export const SLACK_SEND_MESSAGE_V1: ActionSchema = {
  key: 'slack.send-message',
  name: 'Send message',
  version: 1,
  arguments: [
    // A channel, private channel, group DM or DM id, or a user id (its DM with the bot).
    { key: 'channel', type: 'text', required: true, allowsVariables: true, parseJson: false },
    { key: 'text', type: 'text', required: true, allowsVariables: true, parseJson: false, multiline: true },
    // Another message's ts, to reply in its thread.
    optional('thread_ts', false),
    // The four settings are booleans: true or false, parsed as JSON.
    optional('reply_broadcast', true),
    optional('mrkdwn', true),
    optional('unfurl_links', true),
    optional('unfurl_media', true),
    // Shown in place of the bot's name and icon (Slack's chat:write.customize scope).
    optional('username', false),
    optional('icon_emoji', false),
  ],
  realSend: 'posts a real Slack message',
  sideEffect: true,
  idempotent: false,
  idempotentBecause:
    'chat.postMessage takes no key Slack deduplicates on, so posting again after an uncertain outcome puts the message in the channel twice.',
}

export const SLACK_SERVICE: ServiceSchema = {
  key: 'slack',
  name: 'Slack',
  actions: [SLACK_SEND_MESSAGE_V1],
  // The static key minter reads `bot_token` from the login (minters/static-key.ts,
  // slackBot); the ops Slack entry reads `team_id` from the target.
  connection: {
    tile: 'A bot in a Slack workspace',
    auth: 'static_key',
    fields: [
      { key: 'team_id', label: 'Workspace ID', input: 'text', required: true, target: 'team_id' },
      { key: 'bot_token', label: 'Bot token', input: 'secret', required: true, login: 'bot_token' },
    ],
  },
}
