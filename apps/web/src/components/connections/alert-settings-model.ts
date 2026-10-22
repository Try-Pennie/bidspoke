/**
 * The Slack alerts login's alert settings, read (#2338, build PR 14; Dan's
 * decision 1 of 2026-10-21, design round 36): the channel Bidspoke's alerts
 * post to and four alert switches, each with one plain line of what it
 * watches, under the login's facts on the Connections page. They were on the
 * Integrations page, which is retired. Pure, so every sentence is tested on
 * its own (alert-settings-model.test.ts); the reducer (alert-settings-state.ts)
 * and the panel (AlertSettings.tsx) read them from here.
 *
 * They are saved through the routes the Integrations page used
 * (GET and PATCH /api/integrations/slack, GET /api/integrations/slack/channels).
 */
import type { SlackAlertSettingsAnswer, SlackAlertSettingsPatch } from '@/lib/api'
import { requestFailureCause } from '@/lib/error-sentence'

/** The four switches, by the key each is stored under. */
export type AlertSwitchKey = 'volume_alerts_enabled' | 'config_alerts_enabled' | 'backup_alerts_enabled' | 'matrix_alerts_enabled'

export interface AlertSwitch {
  key: AlertSwitchKey
  /** Its name, the switch's label. */
  name: string
  /** One plain line of what it watches (round 36's words). */
  watches: string
}

/** Round 36's rows, in its order and its words (Dan, 2026-10-21). */
export const ALERT_SWITCHES: readonly AlertSwitch[] = [
  { key: 'volume_alerts_enabled', name: 'Volume anomaly alerts', watches: "When a day's runs are far above or below normal." },
  { key: 'config_alerts_enabled', name: 'Configuration warning alerts', watches: "When a live step's timeout is too short to be reliable." },
  { key: 'backup_alerts_enabled', name: 'Backup failure alerts', watches: 'When workflow backups to GitHub keep failing.' },
  { key: 'matrix_alerts_enabled', name: 'Bid matrix change alerts', watches: 'When rows of the Salesforce bid matrix change.' },
]

/** The row label of the channel. */
export const POSTS_TO = 'Posts to'

export interface AlertSettings {
  /** The channel the alerts post to, as "#name"; null when the row names none. */
  channel: string | null
  switches: Readonly<Record<AlertSwitchKey, boolean>>
}

/**
 * The settings as the panel shows them, or null when the organization has no
 * Slack alert connection. A switch the row never wrote is on, as every alert
 * reader treats it (lib/slack-connection.ts: opt out only).
 */
export function alertSettingsOf(answer: SlackAlertSettingsAnswer): AlertSettings | null {
  if (!answer.connected) return null
  const on = (v: boolean | undefined) => v !== false
  return {
    channel: typeof answer.default_channel === 'string' && answer.default_channel.trim() !== '' ? answer.default_channel : null,
    switches: {
      volume_alerts_enabled: on(answer.volume_alerts_enabled),
      config_alerts_enabled: on(answer.config_alerts_enabled),
      backup_alerts_enabled: on(answer.backup_alerts_enabled),
      matrix_alerts_enabled: on(answer.matrix_alerts_enabled),
    },
  }
}

/** The body that saves one switch. */
export function switchPatch(key: AlertSwitchKey, to: boolean): SlackAlertSettingsPatch {
  return { [key]: to }
}

const nameOf = (key: AlertSwitchKey) => ALERT_SWITCHES.find((s) => s.key === key)?.name ?? key
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

/** The working line while a switch saves: "Turning off volume anomaly alerts". */
export function switchWorking(key: AlertSwitchKey, to: boolean): string {
  return `Turning ${to ? 'on' : 'off'} ${lowerFirst(nameOf(key))}`
}

/** What a saved switch did, said on the row it changed (L608): "Turned off. These alerts no longer post." */
export function switchSaved(to: boolean): string {
  return to ? 'Turned on. These alerts post again.' : 'Turned off. These alerts no longer post.'
}

/** What a channel save did: "Alerts now post to #ops-alerts." */
export function channelSaved(channel: string): string {
  return `Alerts now post to ${channel}.`
}

/** The integrations routes' refusal for more than one alert row (lib/slack-connection.ts SLACK_ALERT_AMBIGUOUS). */
const SLACK_ALERT_AMBIGUOUS = 'slack_alert_connection_ambiguous'

/** The refusal's own sentence when the route answered one, else what was measured about the call. */
function causeOf(err: unknown): { sentence: string | null; mayHaveLanded: boolean; cause: string } {
  const e = (err ?? {}) as { body?: unknown; timedOut?: unknown; status?: unknown }
  const body = e.body && typeof e.body === 'object' ? (e.body as { message?: unknown; error?: unknown }) : null
  const said = typeof body?.message === 'string' && body.message.trim() !== '' ? body.message
    : body?.error === SLACK_ALERT_AMBIGUOUS ? 'Bidspoke holds more than one Slack alert connection for this organization, so it cannot tell which to change'
    : typeof body?.error === 'string' && body.error.trim() !== '' ? body.error : null
  const status = typeof e.status === 'number' ? e.status : null
  // A call given up on, a server that could not be reached, or one that failed while answering (a 5xx,
  // whatever its body says) may have saved (L11); only a refusal below 500 is known to have saved nothing.
  const mayHaveLanded = e.timedOut === true || status === null || status >= 500
  return { sentence: said, mayHaveLanded, cause: requestFailureCause(err) }
}

/**
 * A switch's save failed: it turns back, and the line says what did not
 * happen, why, and where it stands now. When the call may still have landed
 * (no answer, a server error), it says so rather than "nothing was saved".
 */
export function switchFailed(key: AlertSwitchKey, to: boolean, err: unknown): string {
  const name = nameOf(key)
  const { sentence, mayHaveLanded, cause } = causeOf(err)
  const why = sentence ? sentence.replace(/\.$/, '') : cause
  const was = to ? 'off' : 'on'
  if (mayHaveLanded) return `${name} may not have been turned ${to ? 'on' : 'off'}: ${why}. Reload the page to see whether it is ${to ? 'on' : 'off'}.`
  return `${name} was not turned ${to ? 'on' : 'off'}: ${why}. It is still ${was}.`
}

/** A channel save failed: the channel shown stays the one saved. */
export function channelFailed(channel: string, err: unknown): string {
  const { sentence, mayHaveLanded, cause } = causeOf(err)
  const why = sentence ? sentence.replace(/\.$/, '') : cause
  if (mayHaveLanded) return `Alerts may not have been moved to ${channel}: ${why}. Reload the page to see where they post.`
  return `Alerts were not moved to ${channel}: ${why}. They still post where they did.`
}

/** The settings could not be read. */
export function settingsUnreadable(err: unknown): string {
  const { sentence, cause } = causeOf(err)
  return `The alert settings could not be read: ${sentence ? sentence.replace(/\.$/, '') : cause}.`
}

/**
 * The panel's line when the organization has no Slack alert connection to set.
 * Connecting a first alert bot (and checking a token's workspace) has no page
 * since the Integrations page was retired: #2642.
 */
export const NOT_CONNECTED = 'This organization has no Slack alert connection, so there are no alert settings to show.'

/** The fewest letters a channel search sends, as GET /api/integrations/slack/channels requires. */
export const CHANNEL_SEARCH_MIN = 3

/** A search's refusal, thrown into the dropdown's menu as a sentence (the Combobox shows it as it is). */
export function channelSearchFailed(err: unknown): string {
  const { sentence, cause } = causeOf(err)
  return `The channels could not be searched: ${sentence ? sentence.replace(/\.$/, '') : cause}.`
}
