import { describe, expect, it } from 'vitest'
import { INCIDENT_SIGNALS, incidentSignal, type IncidentSignal } from '../incident-signals'
import { WINDOW_MINUTES as SLOW_WINDOW_MINUTES } from '../slow-execution-rate'
import { RECENT_WINDOW_MINUTES } from '../volume-cliff'
import { DAY_WINDOW_MINUTES, DEAD_SIGNAL, DEAD_WINDOW_DAYS, DROUGHT_WINDOW_MINUTES, WRONG_PATH_SIGNAL } from '../field-presence-anomaly'
import { STORED_COPY_SERVING_KEY, STORED_COPY_SERVING_WINDOW_MINUTES } from '../stored-copy-signals'
import { PARTNER_REACHABILITY_RECOVERY_PREFIX } from '../partner-block-alert'
import { DB_UNREACHABLE_PREFIX } from '../volume-cliff'

/**
 * The incident registry (#2099, #818): one entry per recovery prefix an alert
 * arms, so the incident record knows every signal it can receive, how to label
 * it for a reader, and whose it is. The compiler holds the CALL sites to it (the
 * recovery functions take its type); these tests hold its CONTENT to the checks
 * it describes, since a number copied here could drift from the module it came
 * from without either noticing.
 */
describe('INCIDENT_SIGNALS', () => {
  it('names the twelve recovery prefixes in use, each once', () => {
    const names = INCIDENT_SIGNALS.map((s) => s.signal)
    expect(new Set(names).size).toBe(names.length)
    expect([...names].sort()).toEqual([
      'db-unreachable',
      'failure-rate',
      'field-presence-dead',
      'field-presence-drought',
      'field-presence-wrong-path',
      'partner-reachability',
      'pg-cron-watch',
      'slow-spike',
      'stored-copy-serving',
      'supabase-memory',
      'volume-cliff',
      'workflow-schedule',
    ])
  })

  it('scopes the workflow signals to their organization and the shared ones to the platform', () => {
    const scope = (s: IncidentSignal) => incidentSignal(s).scope
    for (const s of ['failure-rate', 'slow-spike', 'volume-cliff', 'db-unreachable', 'field-presence-drought', 'field-presence-dead', 'field-presence-wrong-path'] as const) {
      expect(scope(s), s).toBe('org')
    }
    // A partner host is shared by every organization's leads, and the probe reports
    // under the literal org 'probe', so neither may be read as an organization.
    for (const s of ['partner-reachability', 'supabase-memory', 'pg-cron-watch', 'stored-copy-serving', 'workflow-schedule'] as const) {
      expect(scope(s), s).toBe('platform')
    }
  })

  it('takes each window from the check that measures it', () => {
    expect(incidentSignal('slow-spike').windowMinutes).toBe(SLOW_WINDOW_MINUTES)
    expect(incidentSignal('volume-cliff').windowMinutes).toBe(RECENT_WINDOW_MINUTES)
    expect(incidentSignal('field-presence-drought').windowMinutes).toBe(DROUGHT_WINDOW_MINUTES)
    expect(incidentSignal('field-presence-dead').windowMinutes).toBe(DEAD_WINDOW_DAYS * DAY_WINDOW_MINUTES)
    expect(incidentSignal('field-presence-wrong-path').windowMinutes).toBe(DEAD_WINDOW_DAYS * DAY_WINDOW_MINUTES)
    expect(incidentSignal('stored-copy-serving').windowMinutes).toBe(STORED_COPY_SERVING_WINDOW_MINUTES)
    // Each failure-rate signal carries its own window, so the call supplies it.
    expect(incidentSignal('failure-rate').windowMinutes).toBe('per_call')
    // A check that judges a state rather than a trailing window has none.
    for (const s of ['db-unreachable', 'partner-reachability', 'supabase-memory', 'pg-cron-watch', 'workflow-schedule'] as const) {
      expect(incidentSignal(s).windowMinutes, s).toBeNull()
    }
  })

  it('labels each signal with the words its all-clear already uses', () => {
    expect(incidentSignal('field-presence-dead').label.toLowerCase()).toBe(DEAD_SIGNAL)
    expect(incidentSignal('field-presence-wrong-path').label.toLowerCase()).toBe(WRONG_PATH_SIGNAL)
    expect(incidentSignal('volume-cliff').label).toBe('Volume cliff')
    expect(incidentSignal('db-unreachable').label).toBe('Database unreachable')
    for (const s of INCIDENT_SIGNALS) {
      expect(s.label.length, s.signal).toBeGreaterThan(0)
      expect(s.startMeans.length, s.signal).toBeGreaterThan(0)
    }
  })

  it('agrees with the prefixes the checks export', () => {
    expect(incidentSignal(STORED_COPY_SERVING_KEY).signal).toBe('stored-copy-serving')
    expect(incidentSignal(PARTNER_REACHABILITY_RECOVERY_PREFIX).signal).toBe('partner-reachability')
    expect(incidentSignal(DB_UNREACHABLE_PREFIX).signal).toBe('db-unreachable')
  })

  it('lists the partner kinds and the two database memory subjects', () => {
    expect(incidentSignal('partner-reachability').kinds).toEqual(['blocked', 'unreachable', 'control-failing', 'probe-broken'])
    expect(incidentSignal('supabase-memory').kinds).toEqual(['memory', 'feed'])
  })
})
