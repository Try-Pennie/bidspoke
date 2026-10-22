/**
 * The alert settings' words (#2338, build PR 14): round 36's rows in its
 * order, the settings read from GET /api/integrations/slack, and every
 * sentence a save says, each telling a refusal from a call that may have
 * landed (L11).
 */
import { describe, expect, it } from 'vitest'
import {
  ALERT_SWITCHES, alertSettingsOf, channelFailed, channelSaved, channelSearchFailed, settingsUnreadable, switchFailed, switchPatch, switchSaved, switchWorking,
} from '../alert-settings-model'

const refused = (message: string, status = 404) => Object.assign(new Error('x'), { status, body: { error: message } })

describe('round 36\'s rows', () => {
  it('are the four switches in Dan\'s order and words', () => {
    expect(ALERT_SWITCHES.map((s) => [s.name, s.watches])).toEqual([
      ['Volume anomaly alerts', "When a day's runs are far above or below normal."],
      ['Configuration warning alerts', "When a live step's timeout is too short to be reliable."],
      ['Backup failure alerts', 'When workflow backups to GitHub keep failing.'],
      ['Bid matrix change alerts', 'When rows of the Salesforce bid matrix change.'],
    ])
  })
})

describe('the settings read', () => {
  it('a switch the row never wrote is on, as every alert reader treats it; no matrix channel is read', () => {
    expect(alertSettingsOf({ connected: true, default_channel: '#bidspoke-alerts', volume_alerts_enabled: false })).toEqual({
      channel: '#bidspoke-alerts',
      switches: { volume_alerts_enabled: false, config_alerts_enabled: true, backup_alerts_enabled: true, matrix_alerts_enabled: true },
    })
  })
  it('no Slack alert connection is none, and an empty channel is none', () => {
    expect(alertSettingsOf({ connected: false })).toBeNull()
    expect(alertSettingsOf({ connected: true, default_channel: '  ' })?.channel).toBeNull()
  })
  it('a switch saves alone', () => {
    expect(switchPatch('backup_alerts_enabled', false)).toEqual({ backup_alerts_enabled: false })
  })
})

describe('what a save says', () => {
  it('started, then what it did', () => {
    expect(switchWorking('volume_alerts_enabled', false)).toBe('Turning off volume anomaly alerts')
    expect(switchWorking('matrix_alerts_enabled', true)).toBe('Turning on bid matrix change alerts')
    expect(switchSaved(false)).toBe('Turned off. These alerts no longer post.')
    expect(switchSaved(true)).toBe('Turned on. These alerts post again.')
    expect(channelSaved('#ops-alerts')).toBe('Alerts now post to #ops-alerts.')
  })

  it('a refusal says what did not happen, why, and where it stands', () => {
    expect(switchFailed('volume_alerts_enabled', false, refused('Slack is not connected'))).toBe('Volume anomaly alerts was not turned off: Slack is not connected. It is still on.')
    expect(channelFailed('#ops-alerts', refused('Slack is not connected'))).toBe('Alerts were not moved to #ops-alerts: Slack is not connected. They still post where they did.')
  })

  it('more than one alert row is named in words, never as its code', () => {
    const ambiguous = Object.assign(new Error('x'), { status: 409, body: { error: 'slack_alert_connection_ambiguous' } })
    const s = switchFailed('config_alerts_enabled', true, ambiguous)
    expect(s).toBe('Configuration warning alerts was not turned on: Bidspoke holds more than one Slack alert connection for this organization, so it cannot tell which to change. It is still off.')
    expect(s).not.toMatch(/slack_alert/)
  })

  it('a call that may have landed never says it did not: it says to reload and see', () => {
    const timedOut = Object.assign(new Error('Timed out'), { timedOut: true, timeoutMs: 30_000 })
    expect(switchFailed('backup_alerts_enabled', false, timedOut)).toBe('Backup failure alerts may not have been turned off: the server did not answer within 30 seconds. Reload the page to see whether it is off.')
    expect(channelFailed('#ops-alerts', new TypeError('Failed to fetch'))).toBe('Alerts may not have been moved to #ops-alerts: the server could not be reached. Reload the page to see where they post.')
    // A 5xx whose body names the failure may still have written: it is said as not known, with the body's words.
    const serverFailed = Object.assign(new Error('x'), { status: 503, body: { error: 'canceling statement due to statement timeout' } })
    expect(switchFailed('volume_alerts_enabled', false, serverFailed)).toBe('Volume anomaly alerts may not have been turned off: canceling statement due to statement timeout. Reload the page to see whether it is off.')
    expect(channelFailed('#ops-alerts', serverFailed)).toBe('Alerts may not have been moved to #ops-alerts: canceling statement due to statement timeout. Reload the page to see where they post.')
  })

  it('a read or a search that failed says so in a sentence', () => {
    expect(settingsUnreadable(new TypeError('Failed to fetch'))).toBe('The alert settings could not be read: the server could not be reached.')
    expect(channelSearchFailed(Object.assign(new Error('x'), { status: 502, body: { error: 'Slack API error: ratelimited' } }))).toBe('The channels could not be searched: Slack API error: ratelimited.')
  })
})
