import { describe, it, expect } from 'vitest'
import { alertsFor, ARCHIVE_JOB_NAMES, LAG_ALERT_HOURS } from '../alerts'
import type { RunResult } from '../run-loop'

const base: RunResult = {
  stop: 'caught-up',
  failed: false,
  hoursArchived: 3,
  hoursEmpty: 0,
  executionsArchived: 900,
  executionsRefused: 0,
  hoursBehind: 0,
  detail: 'archived the hour beginning 2026-08-18T10:00:00.000Z',
}

const run = (over: Partial<RunResult> = {}): RunResult => ({ ...base, ...over })

describe('alertsFor', () => {
  // notifyExportFailure DELETES both its grace marker and its cooldown when
  // called with no errors. An hourly job alternating a transient failure with a
  // clean stop would re-arm the grace every other run and never reach the second
  // consecutive failure that pages (L53), which is the backlog state #749 is about.
  it('produces no alert call at all for a healthy run', () => {
    expect(alertsFor(run())).toEqual([])
  })

  it('produces no alert call for a clean stop on a budget', () => {
    expect(alertsFor(run({ stop: 'wall-time', hoursBehind: 2 }))).toEqual([])
  })

  it('alerts on a failed run under the ingest name', () => {
    const alerts = alertsFor(run({ failed: true, stop: 'send-failed', detail: 'snowflake refused' }))

    expect(alerts).toHaveLength(1)
    expect(alerts[0].jobName).toBe(ARCHIVE_JOB_NAMES.ingest)
    expect(alerts[0].errors[0]).toMatch(/snowflake refused/)
  })

  // Separate names so a per-execution refusal cannot suppress a genuine ingest
  // outage for the next eight hours through the shared backstop cooldown.
  it('gives refusals their own name, distinct from ingest', () => {
    const alerts = alertsFor(run({ executionsRefused: 2 }))

    expect(alerts).toHaveLength(1)
    expect(alerts[0].jobName).toBe(ARCHIVE_JOB_NAMES.refusal)
    expect(ARCHIVE_JOB_NAMES.refusal).not.toBe(ARCHIVE_JOB_NAMES.ingest)
  })

  it('reports a failure and refusals as two separate alerts', () => {
    const alerts = alertsFor(run({ failed: true, executionsRefused: 2 }))

    expect(alerts.map((a) => a.jobName).sort()).toEqual(
      [ARCHIVE_JOB_NAMES.ingest, ARCHIVE_JOB_NAMES.refusal].sort(),
    )
  })

  // L77: an error classified as survivable must still be counted against a rate,
  // or one benign refusal and a systemic failure refusing everything arrive on
  // the same path and read the same.
  it('words a run where everything was refused differently from a few refusals', () => {
    const few = alertsFor(run({ executionsArchived: 900, executionsRefused: 2 }))
    const all = alertsFor(run({ executionsArchived: 0, executionsRefused: 900 }))

    expect(few[0].errors[0]).not.toBe(all[0].errors[0])
    expect(all[0].errors[0]).toMatch(/every/i)
  })

  it('states the refusal rate, not just the count', () => {
    const alerts = alertsFor(run({ executionsArchived: 98, executionsRefused: 2 }))

    expect(alerts[0].errors[0]).toMatch(/2 of 100/)
  })

  it('alerts on lag past the threshold, under its own name', () => {
    const alerts = alertsFor(run({ stop: 'wall-time', hoursBehind: LAG_ALERT_HOURS + 1 }))

    expect(alerts).toHaveLength(1)
    expect(alerts[0].jobName).toBe(ARCHIVE_JOB_NAMES.lag)
    expect(alerts[0].errors[0]).toMatch(new RegExp(String(LAG_ALERT_HOURS + 1)))
  })

  it('stays quiet at exactly the lag threshold, so the archive sitting at its normal offset is not an alert', () => {
    expect(alertsFor(run({ stop: 'wall-time', hoursBehind: LAG_ALERT_HOURS }))).toEqual([])
  })

  it('keeps the lag threshold clear of the settle window, which is a normal permanent offset', () => {
    // The archive is always at least the settle window behind by design, so a
    // threshold at or below it would alert forever on a healthy system.
    expect(LAG_ALERT_HOURS).toBeGreaterThan(2)
  })

  it('never produces an alert whose errors array is empty', () => {
    const cases = [
      run(),
      run({ failed: true }),
      run({ executionsRefused: 5 }),
      run({ hoursBehind: 99 }),
      run({ failed: true, executionsRefused: 5, hoursBehind: 99 }),
    ]

    for (const result of cases) {
      for (const alert of alertsFor(result)) {
        expect(alert.errors.length, `${alert.jobName} produced an empty errors array`).toBeGreaterThan(0)
      }
    }
  })
})
