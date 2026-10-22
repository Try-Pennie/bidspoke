/**
 * The Slack alerts login's alert settings as state (#2338, build PR 14): the
 * settings' load, each switch's save, and the channel editor with its save.
 * One pure reducer, which the Connections page's reducer hands every
 * `alerts_` event to (connections-state.ts), tested on its own
 * (alert-settings-state.test.ts).
 *
 * Each switch says it started, says what it did, and turns back with a plain
 * sentence if its save fails (L608): pressed, it moves at once and its row
 * shows the working line with the seconds counting; answered, its row says
 * what changed; refused, it moves back and its row says why, in red. A later
 * press of the same switch replaces an earlier one, and an answer to a press
 * that is no longer the latest is ignored, so a late answer never moves a
 * switch the person has moved since.
 */
import { ALERT_SWITCHES, type AlertSettings, type AlertSwitchKey } from './alert-settings-model'

export type AlertsLoad =
  | { kind: 'loading'; startedAt: number }
  | { kind: 'loaded'; settings: AlertSettings }
  /** The organization has no Slack alert connection. */
  | { kind: 'none' }
  | { kind: 'failed'; sentence: string }

/** One switch's save: none yet, running (to which position, since when), done, or refused. */
export type SwitchSave =
  | { kind: 'idle' }
  | { kind: 'saving'; to: boolean; attempt: number; startedAt: number }
  | { kind: 'saved'; to: boolean }
  | { kind: 'failed'; sentence: string }

/** The channel editor: shut, or open with the channel chosen in it and its save. */
export type ChannelEditor =
  | { kind: 'closed'; saved: string | null }
  | {
      kind: 'open'
      chosen: string | null
      save: { kind: 'editing' } | { kind: 'saving'; channel: string; attempt: number; startedAt: number } | { kind: 'failed'; sentence: string }
    }

export interface AlertsState {
  load: AlertsLoad
  switches: Readonly<Record<AlertSwitchKey, SwitchSave>>
  channel: ChannelEditor
  /** The last change started, numbered by the caller; only the latest one's answer counts. */
  lastAttempt: number
}

export type AlertsEvent =
  | { type: 'alerts_requested'; at: number }
  | { type: 'alerts_answered'; settings: AlertSettings | null }
  | { type: 'alerts_refused'; sentence: string }
  /** A switch pressed: numbered by the caller above every earlier change. */
  | { type: 'alerts_switch_requested'; key: AlertSwitchKey; to: boolean; attempt: number; at: number }
  | { type: 'alerts_switch_answered'; key: AlertSwitchKey; attempt: number }
  | { type: 'alerts_switch_refused'; key: AlertSwitchKey; attempt: number; sentence: string }
  | { type: 'alerts_channel_opened' }
  | { type: 'alerts_channel_chosen'; channel: string }
  | { type: 'alerts_channel_closed' }
  | { type: 'alerts_channel_save_requested'; attempt: number; at: number }
  | { type: 'alerts_channel_save_answered'; attempt: number; channel: string }
  | { type: 'alerts_channel_save_refused'; attempt: number; sentence: string }

const IDLE: SwitchSave = { kind: 'idle' }

export function initialAlertsState(now: number): AlertsState {
  return {
    load: { kind: 'loading', startedAt: now },
    switches: Object.fromEntries(ALERT_SWITCHES.map((s) => [s.key, IDLE])) as Record<AlertSwitchKey, SwitchSave>,
    channel: { kind: 'closed', saved: null },
    lastAttempt: 0,
  }
}

/** Whether anything here is waiting on the server, so the page's clock counts seconds. */
export function alertsWaiting(s: AlertsState): boolean {
  return s.load.kind === 'loading'
    || Object.values(s.switches).some((x) => x.kind === 'saving')
    || (s.channel.kind === 'open' && s.channel.save.kind === 'saving')
}

/** What leaving now would lose here: a channel chosen and not saved, or one saving. */
export function alertsUnsaved(s: AlertsState): 'channel' | 'channel_saving' | null {
  if (s.channel.kind !== 'open') return null
  if (s.channel.save.kind === 'saving') return 'channel_saving'
  const saved = s.load.kind === 'loaded' ? s.load.settings.channel : null
  return s.channel.chosen !== null && s.channel.chosen !== saved ? 'channel' : null
}

function withSwitch(s: AlertsState, key: AlertSwitchKey, to: boolean): AlertsState {
  if (s.load.kind !== 'loaded') return s
  const settings = { ...s.load.settings, switches: { ...s.load.settings.switches, [key]: to } }
  return { ...s, load: { kind: 'loaded', settings } }
}

export function alertsReducer(s: AlertsState, e: AlertsEvent): AlertsState {
  switch (e.type) {
    case 'alerts_requested':
      return { ...s, load: { kind: 'loading', startedAt: e.at } }
    case 'alerts_answered':
      return { ...s, load: e.settings ? { kind: 'loaded', settings: e.settings } : { kind: 'none' } }
    case 'alerts_refused':
      return { ...s, load: { kind: 'failed', sentence: e.sentence } }

    case 'alerts_switch_requested': {
      if (s.load.kind !== 'loaded' || e.attempt <= s.lastAttempt) return s
      // It moves at once (it started); its row counts the seconds until the save answers.
      const moved = withSwitch(s, e.key, e.to)
      return { ...moved, lastAttempt: e.attempt, switches: { ...s.switches, [e.key]: { kind: 'saving', to: e.to, attempt: e.attempt, startedAt: e.at } } }
    }
    case 'alerts_switch_answered': {
      const save = s.switches[e.key]
      if (save.kind !== 'saving' || save.attempt !== e.attempt) return s
      return { ...s, switches: { ...s.switches, [e.key]: { kind: 'saved', to: save.to } } }
    }
    case 'alerts_switch_refused': {
      const save = s.switches[e.key]
      if (save.kind !== 'saving' || save.attempt !== e.attempt) return s
      // It turns back to where it was, and its row says why.
      const back = withSwitch(s, e.key, !save.to)
      return { ...back, switches: { ...s.switches, [e.key]: { kind: 'failed', sentence: e.sentence } } }
    }

    case 'alerts_channel_opened':
      if (s.load.kind !== 'loaded' || s.channel.kind === 'open') return s
      return { ...s, channel: { kind: 'open', chosen: null, save: { kind: 'editing' } } }
    case 'alerts_channel_chosen':
      if (s.channel.kind !== 'open' || s.channel.save.kind === 'saving') return s
      return { ...s, channel: { ...s.channel, chosen: e.channel, save: { kind: 'editing' } } }
    case 'alerts_channel_closed':
      // Cancel closes the editor, even while a save runs; that save's answer still lands on the row.
      if (s.channel.kind !== 'open') return s
      return { ...s, channel: { kind: 'closed', saved: null } }
    case 'alerts_channel_save_requested': {
      const c = s.channel
      if (c.kind !== 'open' || c.chosen === null || c.save.kind === 'saving' || e.attempt <= s.lastAttempt) return s
      return { ...s, lastAttempt: e.attempt, channel: { ...c, save: { kind: 'saving', channel: c.chosen, attempt: e.attempt, startedAt: e.at } } }
    }
    case 'alerts_channel_save_answered': {
      // The channel moved once any save answered; it closes the editor only if this was the editor's own save.
      if (s.load.kind !== 'loaded') return s
      const load: AlertsLoad = { kind: 'loaded', settings: { ...s.load.settings, channel: e.channel } }
      const own = s.channel.kind === 'open' && s.channel.save.kind === 'saving' && s.channel.save.attempt === e.attempt
      const closedSince = s.channel.kind === 'closed'
      return { ...s, load, channel: own || closedSince ? { kind: 'closed', saved: e.channel } : s.channel }
    }
    case 'alerts_channel_save_refused': {
      const c = s.channel
      if (c.kind !== 'open' || c.save.kind !== 'saving' || c.save.attempt !== e.attempt) return s
      return { ...s, channel: { ...c, save: { kind: 'failed', sentence: e.sentence } } }
    }
  }
}
