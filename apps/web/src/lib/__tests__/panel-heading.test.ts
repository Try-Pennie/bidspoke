import { describe, expect, it } from 'vitest'
import { NODE_TYPES } from '@bidspoke/node-types'
import { panelHeadingOf } from '../panel-heading'

/**
 * The small line above a step's name in its settings panel (#2765; settled in
 * docs/design/app-action-panel-heading.html). An App Action step reads its service
 * and action as its card names them; every other step keeps its type word.
 */
describe('panelHeadingOf', () => {
  it('reads a finished App Action step as its service, then its action (D1)', () => {
    expect(panelHeadingOf('app_action', { service: 'google', action: 'google.gmail-send-email', actionVersion: 1 })).toBe('Gmail, Send an email')
    expect(panelHeadingOf('app_action', { service: 'slack', action: 'slack.send-message', actionVersion: 1 })).toBe('Slack, Send message')
  })

  it('reads the service alone while no action is chosen (D3)', () => {
    expect(panelHeadingOf('app_action', { service: 'slack' })).toBe('Slack')
    // A version the catalogue does not have names no action, as the card does.
    expect(panelHeadingOf('app_action', { service: 'slack', action: 'slack.send-message', actionVersion: 9 })).toBe('Slack')
  })

  it('reads App action while no service is chosen (D3)', () => {
    expect(panelHeadingOf('app_action', {})).toBe('App action')
  })

  it('keeps every other step type\'s line exactly as it was', () => {
    expect(panelHeadingOf('code', { script: 'return 1' })).toBe('code')
    expect(panelHeadingOf('webhook', {})).toBe('webhook')
    expect(panelHeadingOf('buyer_select', {})).toBe('buyer_select')
  })
})

/**
 * Types whose panel heading still shows the raw type name with its underscore,
 * because no design round has settled their words yet (#2765 reported them).
 * This list may only shrink: a type that gets readable words must leave it, and
 * the test below fails while a listed type no longer shows an underscore. A new
 * node type may never be added here; it ships with a readable heading.
 */
const RAW_HEADING_NOT_YET_SETTLED: readonly string[] = [
  'branch_end',
  'parallel_end',
  'partner_bid',
  'bid_group',
  'data_store',
  'latency_gate',
  'achieve_offers',
  'buyer_select',
  'buyer_click_send',
  'buyer_click_check',
  'lead_validation',
]

describe('every node type has a readable panel heading', () => {
  it('shows no raw underscore name for any type outside the shrinking exemption list', () => {
    const raw = NODE_TYPES.filter((t) => !RAW_HEADING_NOT_YET_SETTLED.includes(t)).filter((t) => panelHeadingOf(t, {}).includes('_'))
    expect(raw).toEqual([])
  })

  it('holds App Action to readable words in every state, and never exempts it', () => {
    expect(RAW_HEADING_NOT_YET_SETTLED).not.toContain('app_action')
    for (const config of [{}, { service: 'google' }, { service: 'google', action: 'google.gmail-send-email', actionVersion: 1 }]) {
      expect(panelHeadingOf('app_action', config)).not.toContain('_')
    }
  })

  it('lists only real node types that still show an underscore, so the list can only shrink', () => {
    expect(RAW_HEADING_NOT_YET_SETTLED.filter((t) => !(NODE_TYPES as readonly string[]).includes(t))).toEqual([])
    expect(RAW_HEADING_NOT_YET_SETTLED.filter((t) => !panelHeadingOf(t, {}).includes('_'))).toEqual([])
    expect(new Set(RAW_HEADING_NOT_YET_SETTLED).size).toBe(RAW_HEADING_NOT_YET_SETTLED.length)
    expect(RAW_HEADING_NOT_YET_SETTLED.length).toBeLessThanOrEqual(11)
  })
})
