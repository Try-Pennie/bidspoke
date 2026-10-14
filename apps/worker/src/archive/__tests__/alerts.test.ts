import { describe, it, expect } from 'vitest'
import { alertsFor, clearedConditionsFor, ingestRemedyFor, ARCHIVE_JOB_NAMES, ARCHIVE_REFUSAL_REMEDY, ARCHIVE_KILLED_REMEDY, LAG_ALERT_HOURS } from '../alerts'
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

  // #1259: the misconfigured exit (a required secret unset, so the archive
  // refuses to run at all) is an independent condition from a run that stopped
  // partway. notifyExportFailure keys its grace marker and backstop cooldown on
  // the job name, so sharing the ingest name let whichever fired first silence
  // the other for eight hours (L53).
  it('gives the misconfigured exit its own name, distinct from ingest', () => {
    const alerts = alertsFor(run({ failed: true, stop: 'misconfigured', detail: 'SSN_HASH_PEPPER is not set' }))

    expect(alerts).toHaveLength(1)
    expect(alerts[0].jobName).toBe(ARCHIVE_JOB_NAMES.misconfigured)
    expect(ARCHIVE_JOB_NAMES.misconfigured).not.toBe(ARCHIVE_JOB_NAMES.ingest)
  })

  // #835: the only secret this exit names is SSN_HASH_PEPPER, which cannot be
  // re-derived. "Set the named secret" invited a NEW value, which leaves every
  // record already archived unfindable by SSN for an erasure request. The fix
  // is to restore the escrowed value, never to make one.
  it('tells the reader to restore the escrowed pepper, never to set a new one', () => {
    const [alert] = alertsFor(run({ failed: true, stop: 'misconfigured', detail: 'SSN_HASH_PEPPER is not set' }))
    expect(alert.remedy.fixHint).toMatch(/Bidspoke recovery keys/)
    expect(alert.remedy.fixHint).toMatch(/never a new value/i)
    expect(alert.remedy.fixHint).not.toMatch(/<NAME>/)
  })

  // Chosen from what the run reported, not assumed: a second required setting
  // added to this exit later gets the general remedy, which still warns against
  // minting a new recovery secret (lessons review, #835).
  it('gives any other missing setting the general remedy, which still warns against a new recovery secret', () => {
    const [alert] = alertsFor(run({ failed: true, stop: 'misconfigured', detail: 'SOME_OTHER_SETTING is not set' }))
    expect(alert.remedy.fixHint).toMatch(/wrangler secret put/)
    expect(alert.remedy.fixHint).toMatch(/Bidspoke recovery keys/)
    expect(alert.remedy.fixHint).not.toMatch(/SSN_HASH_PEPPER from/)
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

// #1300: a finding is read by someone who does not know the stop codes.
describe('the failed run finding reads in words', () => {
  const failedOn = (stop: string): RunResult =>
    ({ failed: true, stop, detail: 'statement timeout', executionsArchived: 0, executionsRefused: 0, hoursArchived: 0, hoursEmpty: 0, hoursBehind: 0 }) as unknown as RunResult

  for (const stop of ['read-failed', 'send-failed', 'wall-time', 'subrequests', 'max-hours'] as const) {
    it(`names a ${stop} stop in words, keeping the detail`, () => {
      const line = alertsFor(failedOn(stop))[0].errors[0]
      expect(line).not.toContain(stop)
      expect(line).toContain('statement timeout')
    })
  }
})

// One word for one unit (L118): what the backup refuses is executions, and
// "run" in the same alert means the backup run itself.
describe('the refusal findings read like the rest of the alert', () => {
  const refused = (archived: number, refusedCount: number) =>
    alertsFor({ failed: false, stop: 'caught-up', detail: '', executionsArchived: archived, executionsRefused: refusedCount, hoursArchived: 1, hoursEmpty: 0, hoursBehind: 0 } as unknown as RunResult)
      .find((a) => a.jobName === ARCHIVE_JOB_NAMES.refusal)!.errors[0]

  it('opens with a capital and does not call the backup "the archive"', () => {
    for (const line of [refused(0, 4), refused(98, 2)]) {
      expect(line).toMatch(/^[A-Z]/)
      expect(line.toLowerCase()).not.toContain('archive')
    }
  })
})

describe('the refusal alert names what it refused the same way its finding does', () => {
  it('says executions, never runs, for the refused things', () => {
    const r = ARCHIVE_REFUSAL_REMEDY
    expect(`${r.title} ${r.context}`).not.toMatch(/refused (some )?runs|Refused runs|every run/i)
    expect(r.title).toContain('executions')
  })
})

// The vanished run alert waits out its allowance and may never have posted, so
// the takeover alert may not claim one came before it; only that it is the same
// event if one did.
describe('the takeover alert does not claim an alert it cannot know was sent', () => {
  it('names the started and never finished alert conditionally', () => {
    expect(ARCHIVE_KILLED_REMEDY.context).not.toMatch(/alert before this one/)
    expect(ARCHIVE_KILLED_REMEDY.context).toMatch(/if .*started and never finished/i)
  })
})

describe('the falling behind finding reads in words', () => {
  it('names the stop it fell behind on in words', () => {
    const behind = { failed: false, stop: 'wall-time', detail: '', executionsArchived: 5, executionsRefused: 0, hoursArchived: 3, hoursEmpty: 0, hoursBehind: 9 } as unknown as RunResult
    const line = alertsFor(behind).find((a) => a.jobName === ARCHIVE_JOB_NAMES.lag)!.errors[0]
    expect(line).not.toContain('wall-time')
    expect(line).toContain('9 hours behind')
  })
})


/**
 * The remedy is chosen from what actually stopped the run (#1042).
 *
 * One fixed remedy fired for every failure. On 2026-08-24 the cause was a
 * Postgres statement timeout on our own unindexed count, and the advice named
 * Snowflake, the export credentials and Supabase disk. Three wrong places.
 */
describe('ingestRemedyFor', () => {
  it('points a read failure at Postgres, and says Snowflake is not implicated', () => {
    const remedy = ingestRemedyFor('read-failed')

    expect(remedy.title).toMatch(/could not read/)
    expect(remedy.fixHint).toMatch(/in our database, not Snowflake/)
  })

  it('points a send failure at Snowflake, which is the case it belongs to', () => {
    const remedy = ingestRemedyFor('send-failed')

    expect(remedy.fixHint).toMatch(/Check Snowflake availability/)
  })

  it('points a misconfiguration at the secret that is unset', () => {
    expect(ingestRemedyFor('misconfigured').fixHint).toMatch(/wrangler secret put/)
  })

  it('gives every fault its own distinct advice', () => {
    // The defect was that these were all the same sentence. A test that only
    // checked each one said something would have passed throughout.
    const hints = (['read-failed', 'send-failed', 'misconfigured'] as const).map(
      (stop) => ingestRemedyFor(stop).fixHint,
    )
    expect(new Set(hints).size).toBe(3)
  })

  it('is what alertsFor actually attaches, not just a function beside it', () => {
    // Built is not wired (L3). Every test above passed with alertsFor still
    // handing the one generic remedy to every failure, which is the defect.
    const failed = (stop: 'read-failed' | 'send-failed'): RunResult =>
      ({
        failed: true,
        stop,
        detail: 'something went wrong',
        executionsArchived: 0,
        executionsRefused: 0,
        hoursArchived: 0,
        hoursEmpty: 0,
        hoursBehind: 0,
      }) as unknown as RunResult

    const readAlert = alertsFor(failed('read-failed')).find((a) => a.jobName === ARCHIVE_JOB_NAMES.ingest)
    const sendAlert = alertsFor(failed('send-failed')).find((a) => a.jobName === ARCHIVE_JOB_NAMES.ingest)

    expect(readAlert?.remedy.fixHint).toBe(ingestRemedyFor('read-failed').fixHint)
    expect(sendAlert?.remedy.fixHint).toBe(ingestRemedyFor('send-failed').fixHint)
    expect(readAlert?.remedy.fixHint).not.toBe(sendAlert?.remedy.fixHint)
  })

  it('keeps the generic wording for a run that stopped on a budget rather than a fault', () => {
    // wall-time is not a failure of anything, so naming a system to go and
    // check would be inventing a cause (L11).
    const remedy = ingestRemedyFor('wall-time')

    expect(remedy.fixHint).toMatch(/Read the stop reason/)
    expect(remedy.fixHint).not.toMatch(/Check Snowflake availability/)
  })
})

/**
 * Which conditions a finished run shows to be CLEAR (#1441).
 *
 * Without this the archive only ever reports failures, so the escalating
 * reminder schedule never learns that anything recovered: on 2026-09-22 two
 * timeouts 22 successful runs apart arrived as one incident standing for 21
 * hours.
 *
 * A FAILED RUN CLEARS NOTHING, however healthy its other numbers look. A run
 * that stopped early measured less than it appears to: the misconfigured exit
 * returns an empty result whose `hoursBehind` is zero and whose refusal count is
 * zero, and reading those as evidence would clear two conditions on a run that
 * never looked at either (L98, L706).
 */
describe('clearedConditionsFor', () => {
  it('clears every condition a healthy run measured', () => {
    expect(clearedConditionsFor(run())).toEqual([
      ARCHIVE_JOB_NAMES.ingest,
      ARCHIVE_JOB_NAMES.misconfigured,
      ARCHIVE_JOB_NAMES.refusal,
      ARCHIVE_JOB_NAMES.lag,
    ])
  })

  // #1259: now the misconfigured exit has its own name, a successful run is the
  // evidence that stands it down (the secret was set and the archive ran), so
  // its reminder must be cleared here or it would page forever.
  it('clears the misconfigured condition on a healthy run', () => {
    expect(clearedConditionsFor(run())).toContain(ARCHIVE_JOB_NAMES.misconfigured)
  })

  it('clears nothing at all on a failed run, whatever its other numbers say', () => {
    expect(clearedConditionsFor(run({ failed: true, stop: 'send-failed', detail: 'snowflake refused' }))).toEqual([])
  })

  it('does not clear the refusal condition on a run that refused something', () => {
    const cleared = clearedConditionsFor(run({ executionsRefused: 4 }))

    expect(cleared).toContain(ARCHIVE_JOB_NAMES.ingest)
    expect(cleared).not.toContain(ARCHIVE_JOB_NAMES.refusal)
  })

  it('does not clear the lag condition while the run is still behind', () => {
    const cleared = clearedConditionsFor(run({ stop: 'wall-time', hoursBehind: LAG_ALERT_HOURS + 1 }))

    expect(cleared).toContain(ARCHIVE_JOB_NAMES.ingest)
    expect(cleared).not.toContain(ARCHIVE_JOB_NAMES.lag)
  })

  it('never clears the killed condition, which is about an invocation already over', () => {
    expect(clearedConditionsFor(run())).not.toContain(ARCHIVE_JOB_NAMES.killed)
  })

  it('raises and clears nothing in common, on every shape of run', () => {
    // The two halves must not disagree: a condition cannot be both raised and
    // reported clear by the same run, or the alert and the recovery race.
    for (const over of [
      {},
      { executionsRefused: 4 },
      { failed: true, stop: 'send-failed' as const },
      { stop: 'wall-time' as const, hoursBehind: LAG_ALERT_HOURS + 1 },
      { failed: true, stop: 'misconfigured' as const, executionsRefused: 2, hoursBehind: 99 },
    ]) {
      const result = run(over)
      const raised = alertsFor(result).map((a) => a.jobName)
      const cleared = clearedConditionsFor(result)
      expect(raised.filter((name) => cleared.includes(name))).toEqual([])
    }
  })
})
