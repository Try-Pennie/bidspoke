/**
 * The Slack alerts login's alert settings reducer (#2338, build PR 14): each
 * switch says it started, says what it did, and turns back if its save fails
 * (L608); the channel editor's save; late answers never move a switch or the
 * channel the person has changed since.
 */
import { describe, expect, it } from 'vitest'
import { alertsReducer, alertsUnsaved, alertsWaiting, initialAlertsState, type AlertsEvent, type AlertsState } from '../alert-settings-state'
import type { AlertSettings } from '../alert-settings-model'

const T = 1_000_000
const SETTINGS: AlertSettings = {
  channel: '#bidspoke-alerts',
  switches: { volume_alerts_enabled: true, config_alerts_enabled: true, backup_alerts_enabled: true, matrix_alerts_enabled: true },
}

const run = (events: AlertsEvent[], from: AlertsState = initialAlertsState(T)) => events.reduce(alertsReducer, from)
const loaded = () => run([{ type: 'alerts_answered', settings: SETTINGS }])
const shown = (s: AlertsState) => (s.load.kind === 'loaded' ? s.load.settings : null)

describe('the settings load', () => {
  it('starts loading, then holds what was read, or none when there is no Slack alert connection, or why it failed', () => {
    expect(initialAlertsState(T).load).toEqual({ kind: 'loading', startedAt: T })
    expect(loaded().load).toEqual({ kind: 'loaded', settings: SETTINGS })
    expect(run([{ type: 'alerts_answered', settings: null }]).load).toEqual({ kind: 'none' })
    expect(run([{ type: 'alerts_refused', sentence: 'The alert settings could not be read: x.' }]).load).toEqual({ kind: 'failed', sentence: 'The alert settings could not be read: x.' })
    expect(alertsWaiting(initialAlertsState(T))).toBe(true)
    expect(alertsWaiting(loaded())).toBe(false)
  })
})

describe('a switch', () => {
  it('moves at once and counts while it saves, then says it saved', () => {
    const saving = run([{ type: 'alerts_switch_requested', key: 'volume_alerts_enabled', to: false, attempt: 1, at: T }], loaded())
    expect(shown(saving)?.switches.volume_alerts_enabled).toBe(false)
    expect(saving.switches.volume_alerts_enabled).toEqual({ kind: 'saving', to: false, attempt: 1, startedAt: T })
    expect(alertsWaiting(saving)).toBe(true)
    const saved = alertsReducer(saving, { type: 'alerts_switch_answered', key: 'volume_alerts_enabled', attempt: 1 })
    expect(saved.switches.volume_alerts_enabled).toEqual({ kind: 'saved', to: false })
    expect(shown(saved)?.switches.volume_alerts_enabled).toBe(false)
  })

  it('turns back when its save fails, with the sentence on its row', () => {
    const failed = run([
      { type: 'alerts_switch_requested', key: 'backup_alerts_enabled', to: false, attempt: 1, at: T },
      { type: 'alerts_switch_refused', key: 'backup_alerts_enabled', attempt: 1, sentence: 'Backup failure alerts was not turned off: x. It is still on.' },
    ], loaded())
    expect(shown(failed)?.switches.backup_alerts_enabled).toBe(true)
    expect(failed.switches.backup_alerts_enabled).toEqual({ kind: 'failed', sentence: 'Backup failure alerts was not turned off: x. It is still on.' })
  })

  it('a late answer to an earlier press never moves the switch the person has pressed since', () => {
    const s = run([
      { type: 'alerts_switch_requested', key: 'matrix_alerts_enabled', to: false, attempt: 1, at: T },
      { type: 'alerts_switch_requested', key: 'matrix_alerts_enabled', to: true, attempt: 2, at: T + 1 },
      { type: 'alerts_switch_refused', key: 'matrix_alerts_enabled', attempt: 1, sentence: 'late' },
    ], loaded())
    expect(shown(s)?.switches.matrix_alerts_enabled).toBe(true)
    expect(s.switches.matrix_alerts_enabled).toMatchObject({ kind: 'saving', attempt: 2 })
  })

  it('touches no other switch, and is refused before the settings are read or for a number not above the last', () => {
    const s = run([{ type: 'alerts_switch_requested', key: 'config_alerts_enabled', to: false, attempt: 1, at: T }], loaded())
    expect(shown(s)?.switches).toEqual({ ...SETTINGS.switches, config_alerts_enabled: false })
    expect(s.switches.volume_alerts_enabled).toEqual({ kind: 'idle' })
    const early = run([{ type: 'alerts_switch_requested', key: 'config_alerts_enabled', to: false, attempt: 1, at: T }])
    expect(early.switches.config_alerts_enabled).toEqual({ kind: 'idle' })
    expect(alertsReducer(s, { type: 'alerts_switch_requested', key: 'volume_alerts_enabled', to: false, attempt: 1, at: T })).toBe(s)
  })
})

describe('the channel editor', () => {
  it('opens, takes a channel, saves it and closes saying where alerts now post', () => {
    const open = run([{ type: 'alerts_channel_opened' }, { type: 'alerts_channel_chosen', channel: '#ops-alerts' }], loaded())
    expect(open.channel).toEqual({ kind: 'open', chosen: '#ops-alerts', save: { kind: 'editing' } })
    expect(alertsUnsaved(open)).toBe('channel')
    const saving = alertsReducer(open, { type: 'alerts_channel_save_requested', attempt: 1, at: T })
    expect(saving.channel).toMatchObject({ kind: 'open', save: { kind: 'saving', channel: '#ops-alerts', attempt: 1 } })
    expect(alertsUnsaved(saving)).toBe('channel_saving')
    expect(alertsWaiting(saving)).toBe(true)
    const saved = alertsReducer(saving, { type: 'alerts_channel_save_answered', attempt: 1, channel: '#ops-alerts' })
    expect(saved.channel).toEqual({ kind: 'closed', saved: '#ops-alerts' })
    expect(shown(saved)?.channel).toBe('#ops-alerts')
    expect(alertsUnsaved(saved)).toBeNull()
  })

  it('a refused save keeps the editor open with its sentence, and the channel shown stays the saved one', () => {
    const s = run([
      { type: 'alerts_channel_opened' }, { type: 'alerts_channel_chosen', channel: '#ops-alerts' },
      { type: 'alerts_channel_save_requested', attempt: 1, at: T },
      { type: 'alerts_channel_save_refused', attempt: 1, sentence: 'Alerts were not moved to #ops-alerts: x. They still post where they did.' },
    ], loaded())
    expect(s.channel).toMatchObject({ kind: 'open', chosen: '#ops-alerts', save: { kind: 'failed' } })
    expect(shown(s)?.channel).toBe('#bidspoke-alerts')
    // Choosing again clears the failed line.
    expect(alertsReducer(s, { type: 'alerts_channel_chosen', channel: '#ops' }).channel).toMatchObject({ save: { kind: 'editing' } })
  })

  it('Save needs a channel chosen; choosing the channel already saved leaves nothing unsaved', () => {
    const open = run([{ type: 'alerts_channel_opened' }], loaded())
    expect(alertsReducer(open, { type: 'alerts_channel_save_requested', attempt: 1, at: T })).toBe(open)
    expect(alertsUnsaved(alertsReducer(open, { type: 'alerts_channel_chosen', channel: '#bidspoke-alerts' }))).toBeNull()
  })

  it('Cancel closes it even while it saves, and the save\'s answer still moves the channel', () => {
    const s = run([
      { type: 'alerts_channel_opened' }, { type: 'alerts_channel_chosen', channel: '#ops-alerts' },
      { type: 'alerts_channel_save_requested', attempt: 1, at: T },
      { type: 'alerts_channel_closed' },
      { type: 'alerts_channel_save_answered', attempt: 1, channel: '#ops-alerts' },
    ], loaded())
    expect(shown(s)?.channel).toBe('#ops-alerts')
    expect(s.channel).toEqual({ kind: 'closed', saved: '#ops-alerts' })
  })

  it('an answer to an earlier save never closes an editor reopened since', () => {
    const s = run([
      { type: 'alerts_channel_opened' }, { type: 'alerts_channel_chosen', channel: '#ops-alerts' },
      { type: 'alerts_channel_save_requested', attempt: 1, at: T },
      { type: 'alerts_channel_closed' }, { type: 'alerts_channel_opened' }, { type: 'alerts_channel_chosen', channel: '#ops' },
      { type: 'alerts_channel_save_answered', attempt: 1, channel: '#ops-alerts' },
    ], loaded())
    expect(s.channel).toEqual({ kind: 'open', chosen: '#ops', save: { kind: 'editing' } })
  })
})
