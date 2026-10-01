/**
 * The transition settings registry (R9 in discussion #1684, built in #1706).
 *
 * Every transition and rollout lane is turned off by one stored setting, declared
 * once in lib/transition-settings.ts. The scan that refuses an unregistered read
 * lives with the other Worker source guards, in
 * apps/web/src/lib/__guards__/worker/transition-settings-registered.test.ts,
 * because it walks files and the Worker tsconfig carries no Node types.
 */
import { describe, it, expect } from 'vitest'
import {
  PIPEDREAM_SHUTDOWN_DATE,
  TRANSITION_SETTINGS,
  TRANSITION_SETTING_STORE,
  transitionSetting,
} from '../transition-settings'

const FULL_KEY = /^(porting|rollout|validation)\.[a-z0-9_]+$/

// ── The registry ──────────────────────────────────────────────────────────────

describe('TRANSITION_SETTINGS', () => {
  it('declares porting.recording_enabled per workflow, Pipedream facing, retired when the cutover settles', () => {
    const entry = transitionSetting('porting.recording_enabled')
    expect(entry.scope).toBe('per_workflow')
    expect(entry.pipedreamFacing).toBe(true)
    expect(entry.retireRule).toMatch(/cutover/i)
  })

  it('declares each key once, in the key shape the scan reads', () => {
    const keys = TRANSITION_SETTINGS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of keys) expect(k).toMatch(FULL_KEY)
  })

  it('gives every entry a retire rule', () => {
    for (const s of TRANSITION_SETTINGS) expect(s.retireRule.trim().length, s.key).toBeGreaterThan(0)
  })

  it('gives every expiry as a real calendar date', () => {
    for (const s of TRANSITION_SETTINGS) {
      if (s.expiresOn === undefined) continue
      expect(s.expiresOn, s.key).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(new Date(`${s.expiresOn}T00:00:00Z`).toISOString().slice(0, 10), s.key).toBe(s.expiresOn)
    }
  })

  // Pipedream Workflows shuts down on 2027-03-31; a Pipedream facing lane still
  // on after that is talking to nothing, so each one must expire by then.
  it('expires every Pipedream facing entry no later than the Pipedream shutdown', () => {
    for (const s of TRANSITION_SETTINGS.filter((e) => e.pipedreamFacing)) {
      expect(s.expiresOn, s.key).toBeDefined()
      expect(s.expiresOn! <= PIPEDREAM_SHUTDOWN_DATE, s.key).toBe(true)
    }
  })

  it('names environment_variables as the one store the values live in', () => {
    expect(TRANSITION_SETTING_STORE).toBe('environment_variables')
  })

  it('refuses a lookup of a key that is not registered, by name', () => {
    expect(() => transitionSetting('porting.not_a_lane')).toThrow(/porting\.not_a_lane is not a registered transition setting/)
  })
})
