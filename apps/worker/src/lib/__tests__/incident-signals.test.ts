import { describe, expect, it } from 'vitest'
import { INCIDENT_SIGNALS, UNRECOGNISED_SIGNAL_LABEL, incidentSignal, incidentSignalLabel, type IncidentSignal, type IncidentSignalEntry } from '../incident-signals'
import { WINDOW_MINUTES as SLOW_WINDOW_MINUTES } from '../slow-execution-rate'
import { RECENT_WINDOW_MINUTES } from '../volume-cliff'
import { DAY_WINDOW_MINUTES, DEAD_SIGNAL, DEAD_WINDOW_DAYS, DROUGHT_WINDOW_MINUTES, WRONG_PATH_SIGNAL } from '../field-presence-anomaly'
import { STORED_COPY_SERVING_KEY, STORED_COPY_SERVING_WINDOW_MINUTES } from '../stored-copy-signals'
import { PARTNER_REACHABILITY_RECOVERY_PREFIX } from '../partner-block-alert'
import { DB_UNREACHABLE_PREFIX } from '../database-reachability'
import { incidentMarkerKey, incidentMarkerStart } from '../incident-signals'
import { recoveryKey } from '../alert-recovery'
import { alertedStatusKey, CRON_HEARTBEAT_SIGNAL } from '../cron-heartbeat'
import { EXPORT_ALERT_SIGNAL } from '../export-alerts'
import { CRON_HEARTBEAT_RECOVERY_WORDS } from '../slack'

/**
 * The incident registry (#2099, #818): one entry per recovery prefix an alert
 * arms, so the incident record knows every signal it can receive, how to label
 * it for a reader, and whose it is. The compiler holds the CALL sites to it (the
 * recovery functions take its type); these tests hold its CONTENT to the checks
 * it describes, since a number copied here could drift from the module it came
 * from without either noticing.
 */
describe('INCIDENT_SIGNALS', () => {
  it('names the sixteen signals in use, each once', () => {
    const names = INCIDENT_SIGNALS.map((s) => s.signal)
    expect(new Set(names).size).toBe(names.length)
    expect([...names].sort()).toEqual([
      'cron-heartbeat',
      'db-unreachable',
      'export-alert',
      'failure-rate',
      'field-presence-dead',
      'field-presence-drought',
      'field-presence-wrong-path',
      'partner-page-live',
      'partner-reachability',
      'pg-cron-watch',
      'slow-spike',
      'stored-copy-serving',
      'supabase-memory',
      'volume-cliff',
      'workflow-schedule',
      'writeback-backlog',
    ])
  })

  it('scopes the workflow signals to their organization and the shared ones to the platform', () => {
    const scope = (s: IncidentSignal) => incidentSignal(s).scope
    for (const s of ['failure-rate', 'slow-spike', 'volume-cliff', 'db-unreachable', 'field-presence-drought', 'field-presence-dead', 'field-presence-wrong-path'] as const) {
      expect(scope(s), s).toBe('org')
    }
    // #468: a stored Salesforce write belongs to one organization, and only its
    // own routes can replay it, so its backlog is that organization's.
    expect(scope('writeback-backlog')).toBe('org')
    // A partner host is shared by every organization's leads, and the probe reports
    // under the literal org 'probe', so neither may be read as an organization.
    for (const s of ['partner-reachability', 'supabase-memory', 'pg-cron-watch', 'stored-copy-serving', 'workflow-schedule'] as const) {
      expect(scope(s), s).toBe('platform')
    }
    // #2135: the partners page channel is every organization's, and the monitor
    // measures it through a synthetic organization no reader belongs to.
    expect(scope('partner-page-live')).toBe('platform')
    // #2103: the heartbeat watches the worker's own crons and the export alerter
    // pages for jobs and checks that run once for every organization (one
    // Snowflake account, one database); both send every Slack organization the
    // same page and key their state on a job name with no organization in it.
    for (const s of ['cron-heartbeat', 'export-alert'] as const) {
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
    for (const s of ['db-unreachable', 'partner-reachability', 'supabase-memory', 'pg-cron-watch', 'workflow-schedule', 'cron-heartbeat', 'export-alert', 'partner-page-live'] as const) {
      expect(incidentSignal(s).windowMinutes, s).toBeNull()
    }
  })

  it('labels each signal with the words its all-clear already uses', () => {
    expect(incidentSignal('field-presence-dead').label.toLowerCase()).toBe(DEAD_SIGNAL)
    expect(incidentSignal('field-presence-wrong-path').label.toLowerCase()).toBe(WRONG_PATH_SIGNAL)
    expect(incidentSignal('volume-cliff').label).toBe('Volume cliff')
    expect(incidentSignal('db-unreachable').label).toBe('Database unreachable')
    // The heartbeat's all-clear names its signal "scheduled job" (#2057).
    expect(incidentSignal('cron-heartbeat').label.toLowerCase()).toBe(CRON_HEARTBEAT_RECOVERY_WORDS)
    for (const s of INCIDENT_SIGNALS) {
      expect(s.label.length, s.signal).toBeGreaterThan(0)
      expect(s.startMeans.length, s.signal).toBeGreaterThan(0)
    }
  })

  it('agrees with the prefixes the checks export', () => {
    expect(incidentSignal(STORED_COPY_SERVING_KEY).signal).toBe('stored-copy-serving')
    expect(incidentSignal(PARTNER_REACHABILITY_RECOVERY_PREFIX).signal).toBe('partner-reachability')
    expect(incidentSignal(DB_UNREACHABLE_PREFIX).signal).toBe('db-unreachable')
    expect(incidentSignal(CRON_HEARTBEAT_SIGNAL).signal).toBe('cron-heartbeat')
    expect(incidentSignal(EXPORT_ALERT_SIGNAL).signal).toBe('export-alert')
  })

  it('lists the partner kinds and the two database memory subjects', () => {
    expect(incidentSignal('partner-reachability').kinds).toEqual(['blocked', 'unreachable', 'control-failing', 'probe-broken'])
    expect(incidentSignal('supabase-memory').kinds).toEqual(['memory', 'feed'])
    expect(incidentSignal('partner-page-live').kinds).toEqual(['channel', 'monitor'])
  })

  it('says which signals key their subject on a workflow id (#2101)', () => {
    // Read from each check's call site: volume-cliff and slow-spike key on the
    // workflow id, failure-rate on `${workflowId}:${match}`, and the three field
    // presence tiers on `${workflowId} ${fieldPath}`. db-unreachable keys on the
    // organization; the rest key on a readable name (a host, a job, a GitHub
    // workflow file, or a fixed id).
    const byWorkflow = INCIDENT_SIGNALS.filter((s) => s.subject === 'workflow').map((s) => s.signal).sort()
    expect(byWorkflow).toEqual(['failure-rate', 'field-presence-dead', 'field-presence-drought', 'field-presence-wrong-path', 'slow-spike', 'volume-cliff'])
    expect(incidentSignal('db-unreachable').subject).toBe('organization')
    expect(incidentSignal('writeback-backlog').subject).toBe('organization')
    for (const s of ['partner-reachability', 'supabase-memory', 'pg-cron-watch', 'stored-copy-serving', 'workflow-schedule', 'cron-heartbeat', 'export-alert', 'partner-page-live'] as const) {
      expect(incidentSignal(s).subject, s).toBe('name')
    }
  })
})

describe('where each signal keeps its open incident marker (#2103)', () => {
  it('names the alert-recovery marker for every signal armed through alert-recovery', () => {
    for (const s of INCIDENT_SIGNALS) {
      if (s.signal === 'cron-heartbeat') continue
      expect(incidentMarkerKey(s.signal, 'subject-1'), s.signal).toBe(recoveryKey(s.signal as Exclude<IncidentSignal, 'cron-heartbeat'>, 'subject-1'))
    }
  })

  it('names the heartbeat\'s own paged status record, the key cron-heartbeat.ts writes and deletes', () => {
    expect(incidentMarkerKey('cron-heartbeat', 'execution-archive')).toBe(alertedStatusKey('execution-archive'))
  })

  it('reads a plain marker as its start', () => {
    expect(incidentMarkerStart('volume-cliff', '2026-10-14T10:00:00.000Z')).toBe('2026-10-14T10:00:00.000Z')
  })

  it('reads the heartbeat record\'s incident start, then its page time for a record written before it had one', () => {
    const record = { status: 'vanished', at: '2026-10-14T11:00:00.000Z', incidentStartedAt: '2026-10-14T10:00:00.000Z' }
    expect(incidentMarkerStart('cron-heartbeat', JSON.stringify(record))).toBe('2026-10-14T10:00:00.000Z')
    expect(incidentMarkerStart('cron-heartbeat', JSON.stringify({ status: 'stale', at: '2026-10-14T11:00:00.000Z' }))).toBe('2026-10-14T11:00:00.000Z')
  })

  it('reads no start from a heartbeat record it cannot parse, rather than inventing one', () => {
    expect(incidentMarkerStart('cron-heartbeat', 'not json')).toBeNull()
    expect(incidentMarkerStart('cron-heartbeat', JSON.stringify({ status: 'stale' }))).toBeNull()
  })
})

describe('incidentSignalLabel (#2101)', () => {
  it('reads the registry label for a known signal', () => {
    expect(incidentSignalLabel('volume-cliff')).toEqual({ label: 'Volume cliff', known: true })
  })

  it('names an unknown signal as unrecognised rather than inventing a label', () => {
    expect(incidentSignalLabel('retired-check')).toEqual({ label: UNRECOGNISED_SIGNAL_LABEL, known: false })
  })

  it('cannot hold an entry with no label', () => {
    // The compiler refuses an entry without a label (the typecheck runs over this
    // file), and every entry present carries a non empty one.
    // @ts-expect-error a registry entry must have a label
    const unlabelled: IncidentSignalEntry = { signal: 'x', scope: 'org', subject: 'name', startMeans: 'x', windowMinutes: null }
    expect(unlabelled.signal).toBe('x')
    for (const s of INCIDENT_SIGNALS) expect(s.label.trim().length, s.signal).toBeGreaterThan(0)
  })
})
