/**
 * The archive run's alert sentences, each held to what the run measured (#835).
 *
 * An audit of every alert sentence found these claiming more than the run knew:
 * a refused execution's day said to be "deleted on the usual schedule" when the
 * gate keeps it, a write to our own database reported as Snowflake being
 * unreachable, a repair's send failure reported as a read of our database, and
 * a lag alert promising "every run reports success" above a run that failed.
 */
import { describe, it, expect } from 'vitest'
import {
  alertsFor,
  ARCHIVE_JOB_NAMES,
  ARCHIVE_KILLED_REMEDY,
  ARCHIVE_LAG_REMEDY,
  ARCHIVE_READ_FAILED_REMEDY,
  ARCHIVE_RECORD_FAILED_REMEDY,
  ARCHIVE_REFUSAL_REMEDY,
  LAG_ALERT_HOURS,
} from '../alerts'
import { runArchive, reArchiveHours, type RunDeps, type RunResult } from '../run-loop'
import { SETTLE_WINDOW_MS } from '../clock'
import { summariseReArchive } from '../../lib/execution-archive'

const base: RunResult = {
  stop: 'caught-up',
  failed: false,
  hoursArchived: 3,
  hoursEmpty: 0,
  executionsArchived: 900,
  executionsRefused: 0,
  hoursBehind: 0,
  detail: '',
}
const run = (over: Partial<RunResult> = {}): RunResult => ({ ...base, ...over })

const HOUR = 60 * 60 * 1000
const WATERMARK = '2026-08-16T10:00:00.000Z'
const NOW = new Date(Date.parse(WATERMARK) + 30 * HOUR + SETTLE_WINDOW_MS)

function deps(overrides: Partial<RunDeps> = {}): RunDeps {
  let watermark = WATERMARK
  return {
    now: () => NOW,
    readWatermark: async () => watermark,
    advanceWatermark: async (h) => {
      watermark = h
    },
    streamHour: async (_s, _e, onSlice) => {
      await onSlice([{ executionId: 'e1', execution: { id: 'e1' }, steps: [] }])
      return { usable: true as const, empty: false as const, executionCount: 1, stepCount: 0, requests: 1 }
    },
    encode: async (b) => ({ executionId: b.executionId, wire: 'x', wireBytes: 10, stepCount: 0 }),
    send: async () => undefined,
    recordArchived: async () => undefined,
    recordRefusal: async () => undefined,
    recordHour: async () => undefined,
    budget: { maxHours: 1, deadlineAt: NOW.getTime() + 10 * 60 * 1000, subrequestsLeft: () => 1000 },
    ...overrides,
  } as RunDeps
}

describe('a refused execution holds its day back, it is not deleted on schedule', () => {
  it('says the day is held back from deletion', () => {
    // disposition.ts: a refused execution is an orphan the deletion gate never
    // clears, so its whole day is kept.
    expect(ARCHIVE_REFUSAL_REMEDY.context).not.toMatch(/deleted on the usual schedule/)
    expect(ARCHIVE_REFUSAL_REMEDY.context).toMatch(/held back from deletion/)
  })

  it('does not say every execution was refused when the run also failed', () => {
    // A run that refused some and then failed archived nothing too, without
    // having refused everything it read.
    const [refusal] = alertsFor(run({ failed: true, stop: 'send-failed', executionsArchived: 0, executionsRefused: 3 }))
      .filter((a) => a.jobName === ARCHIVE_JOB_NAMES.refusal)
    expect(refusal.errors[0]).not.toMatch(/every one/)
    expect(refusal.errors[0]).toMatch(/Refused 3/)
  })

  it('still says every one when a clean run refused all it read', () => {
    const [refusal] = alertsFor(run({ executionsArchived: 0, executionsRefused: 3 }))
    expect(refusal.errors[0]).toMatch(/every one of the 3/)
  })
})

describe('a read failure does not claim nothing was sent', () => {
  it('drops "stopped before sending anything", which a later slice failing makes false', () => {
    expect(ARCHIVE_READ_FAILED_REMEDY.context).not.toMatch(/before sending anything/)
  })
})

describe('the lag alert speaks only above a run that did not fail', () => {
  it('is not raised by a failed run, whose own alert already says it failed', () => {
    const alerts = alertsFor(run({ failed: true, stop: 'read-failed', hoursBehind: LAG_ALERT_HOURS + 5 }))
    expect(alerts.map((a) => a.jobName)).not.toContain(ARCHIVE_JOB_NAMES.lag)
  })

  it('is still raised by a clean run that is behind', () => {
    const alerts = alertsFor(run({ stop: 'wall-time', hoursBehind: LAG_ALERT_HOURS + 5 }))
    expect(alerts.map((a) => a.jobName)).toContain(ARCHIVE_JOB_NAMES.lag)
  })

  it('claims only what the one run measured, not that every run succeeds', () => {
    expect(ARCHIVE_LAG_REMEDY.context).not.toMatch(/every run/i)
  })
})

describe('the killed alert speaks only because kills repeated', () => {
  it('does not say there is nothing to do unless it repeats', () => {
    // kill-rate.ts stays quiet at the ordinary rate, so this alert is the repeat.
    expect(ARCHIVE_KILLED_REMEDY.fixHint).not.toMatch(/unless this repeats/)
  })
})

describe('a failed write to our own database is not reported as Snowflake', () => {
  it('stops on record-failed when the send landed and recording it did not', async () => {
    const result = await runArchive(
      deps({
        recordArchived: async () => {
          throw new Error('recording archived ids failed: 57014 statement timeout')
        },
      }),
    )
    expect(result.stop).toBe('record-failed')
    expect(result.failed).toBe(true)
    expect(result.detail).toMatch(/statement timeout/)
  })

  it('still stops on send-failed when the send itself threw', async () => {
    const result = await runArchive(
      deps({
        send: async () => {
          throw new Error('snowflake refused')
        },
      }),
    )
    expect(result.stop).toBe('send-failed')
  })

  it('alerts under the ingest name with a remedy that names our database, not Snowflake', () => {
    const [alert] = alertsFor(run({ failed: true, stop: 'record-failed', detail: 'hour x: recording failed' }))
    expect(alert.jobName).toBe(ARCHIVE_JOB_NAMES.ingest)
    expect(alert.remedy).toBe(ARCHIVE_RECORD_FAILED_REMEDY)
    expect(alert.remedy.title).not.toMatch(/Snowflake/)
    expect(alert.remedy.fixHint).not.toMatch(/Check Snowflake/)
    expect(alert.errors[0]).not.toMatch(/record-failed/)
  })
})

describe('a repair reports the failure it had, not always a read failure', () => {
  it('reports a repair whose send failed as a send failure', async () => {
    const result = summariseReArchive(
      await reArchiveHours(
        deps({
          send: async () => {
            throw new Error('snowflake refused')
          },
        }) as Parameters<typeof reArchiveHours>[0],
        ['2026-08-16T11:00:00.000Z'],
      ),
    )
    expect(result.failed).toBe(true)
    expect(result.stop).toBe('send-failed')
  })

  it('still reports a repair whose read failed as a read failure', async () => {
    const result = summariseReArchive(
      await reArchiveHours(
        deps({
          streamHour: async () => ({ usable: false as const, reason: 'count did not reconcile', requests: 1 }),
        }) as Parameters<typeof reArchiveHours>[0],
        ['2026-08-16T11:00:00.000Z'],
      ),
    )
    expect(result.stop).toBe('read-failed')
  })
})
