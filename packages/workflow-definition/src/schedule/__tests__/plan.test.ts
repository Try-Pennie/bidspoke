/**
 * planFires (#1952, #1698 1.6 and D8): what one tick of the ops minute cron
 * records for one schedule, given the DATABASE clock, the schedule's floor and
 * the last slot it served. Pure: B2's tick reads now() from the database and
 * the last served slot from schedule_fires (#1948), then writes what this
 * returns; UNIQUE (workflow_id, scheduled_for) there is the second line.
 *
 * The ops Worker's measured cron facts it is built around (docs/ops-ceilings-spike.md):
 * scheduledTime lands at :48 within each minute, so nothing keys on it being on
 * the minute, and a tick can be late, skipped or doubled.
 */
import { describe, expect, it } from 'vitest'
import { DUE_WINDOW_MS, jitterOffsetMs, planFires, scheduleFloorMs, type PlannedFire } from '../plan'
import type { ScheduleConfig } from '../schedule'

const NY = 'America/New_York'
const MIN = 60_000
const HOUR = 3_600_000
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

const dailyTen: ScheduleConfig = { cron: '0 10 * * *', timezone: NY, overlap: 'skip', catch_up: 'none', jitter_max_seconds: 0 }
const weeklyMon: ScheduleConfig = {
  cron: '0 6 * * MON',
  timezone: NY,
  overlap: 'skip',
  catch_up: 'latest',
  catch_up_window_seconds: 72 * 3600,
  reattempt_after_seconds: 4 * 3600,
  jitter_max_seconds: 0,
}
const TEN_EST = Date.UTC(2027, 0, 5, 15, 0) // 2027-01-05 10:00 New York
const FLOOR = Date.UTC(2026, 11, 1)

const slots = (fires: PlannedFire[]) => fires.map((f) => iso(f.scheduled_for))

describe('planFires: the due window', () => {
  it('records a slot that fell in the last five minutes of database time, with no jitter', () => {
    const plan = planFires({ workflowId: 'wf-a', schedule: dailyTen, dbNowMs: TEN_EST + 48_000, floorMs: FLOOR, lastServedMs: TEN_EST - 24 * HOUR })
    expect(plan.fires).toEqual([{ scheduled_for: TEN_EST, dispatch_at: TEN_EST, reason: 'due', previous_scheduled_for: TEN_EST - 24 * HOUR }])
    expect(plan.missed).toBeNull()
  })

  it('the window is five minutes wide', () => {
    expect(DUE_WINDOW_MS).toBe(5 * MIN)
  })

  it('a tick skipped entirely still fires the slot it missed exactly once, across ticks at :48 (D8)', () => {
    let lastServed: number | null = TEN_EST - 24 * HOUR
    const recorded: number[] = []
    // Ticks from 09:58:48 to 10:08:48, with 10:00:48 never running.
    for (let m = -2; m <= 8; m++) {
      if (m === 0) continue
      const plan = planFires({ workflowId: 'wf-a', schedule: dailyTen, dbNowMs: TEN_EST + m * MIN + 48_000, floorMs: FLOOR, lastServedMs: lastServed })
      for (const f of plan.fires) {
        recorded.push(f.scheduled_for)
        lastServed = f.scheduled_for
      }
    }
    expect(recorded.map(iso)).toEqual([iso(TEN_EST)])
  })

  it('a doubled tick that is not told the slot was served lists it again, which the unique slot key absorbs', () => {
    const input = { workflowId: 'wf-a', schedule: dailyTen, dbNowMs: TEN_EST + 48_000, floorMs: FLOOR, lastServedMs: TEN_EST - 24 * HOUR }
    expect(planFires(input).fires).toEqual(planFires(input).fires)
  })

  it('records several slots in one window in order, each pointing at the one before', () => {
    const every2: ScheduleConfig = { cron: '*/2 * * * *', timezone: 'UTC', overlap: 'skip', catch_up: 'none', jitter_max_seconds: 0 }
    const now = Date.UTC(2027, 0, 5, 10, 4, 48)
    const plan = planFires({ workflowId: 'wf-b', schedule: every2, dbNowMs: now, floorMs: FLOOR, lastServedMs: Date.UTC(2027, 0, 5, 9, 58) })
    expect(slots(plan.fires)).toEqual(['2027-01-05T10:00:00.000Z', '2027-01-05T10:02:00.000Z', '2027-01-05T10:04:00.000Z'])
    expect(plan.fires.map((f) => iso(f.previous_scheduled_for))).toEqual(['2027-01-05T09:58:00.000Z', '2027-01-05T10:00:00.000Z', '2027-01-05T10:02:00.000Z'])
  })
})

describe('planFires: the floor (D8)', () => {
  it('a schedule created at 10:30 with a 10:00 daily slot does not fire for 10:00 that day', () => {
    const createdAt = TEN_EST + 30 * MIN
    const plan = planFires({ workflowId: 'wf-a', schedule: dailyTen, dbNowMs: createdAt + 48_000, floorMs: createdAt, lastServedMs: null })
    expect(plan).toEqual({ fires: [], missed: null })
  })

  it('a schedule created at 09:59 fires at 10:00', () => {
    const createdAt = TEN_EST - MIN
    expect(slots(planFires({ workflowId: 'wf-a', schedule: dailyTen, dbNowMs: TEN_EST + 48_000, floorMs: createdAt, lastServedMs: null }).fires)).toEqual([iso(TEN_EST)])
  })

  it('a slot exactly at the floor is not fired: the floor is the instant Pipedream stopped, and it may have run that slot', () => {
    expect(planFires({ workflowId: 'wf-a', schedule: dailyTen, dbNowMs: TEN_EST + 48_000, floorMs: TEN_EST, lastServedMs: null }).fires).toEqual([])
  })

  it('a ported weekly schedule with catch up does not fire for a period before its cutover instant', () => {
    const monday = Date.UTC(2027, 0, 4, 11, 0) // 06:00 EST, run by Pipedream
    const cutover = monday + 2 * HOUR
    const plan = planFires({ workflowId: 'wf-w', schedule: weeklyMon, dbNowMs: cutover + 3 * HOUR, floorMs: cutover, lastServedMs: null })
    expect(plan).toEqual({ fires: [], missed: null })
  })

  it('a floor in the future fires nothing yet', () => {
    expect(planFires({ workflowId: 'wf-a', schedule: dailyTen, dbNowMs: TEN_EST + 48_000, floorMs: TEN_EST + HOUR, lastServedMs: null })).toEqual({ fires: [], missed: null })
  })
})

describe('planFires: catch up by period and the missed window', () => {
  const MON = Date.UTC(2027, 0, 11, 11, 0) // Monday 2027-01-11 06:00 EST
  const LAST_MON = MON - 7 * 24 * HOUR

  it('a weekly slot inside an outage is caught up once, as its latest missed fire, when the outage ends', () => {
    const back = MON + 5 * HOUR
    const plan = planFires({ workflowId: 'wf-w', schedule: weeklyMon, dbNowMs: back, floorMs: FLOOR, lastServedMs: LAST_MON })
    expect(plan.fires).toEqual([{ scheduled_for: MON, dispatch_at: MON, reason: 'catch_up', previous_scheduled_for: LAST_MON }])
    expect(plan.missed).toBeNull()
  })

  it('after the catch up is recorded, the next tick has nothing to do', () => {
    expect(planFires({ workflowId: 'wf-w', schedule: weeklyMon, dbNowMs: MON + 5 * HOUR + MIN, floorMs: FLOOR, lastServedMs: MON })).toEqual({ fires: [], missed: null })
  })

  it('a weekly slot older than the catch up window is reported missed, not fired', () => {
    const plan = planFires({ workflowId: 'wf-w', schedule: weeklyMon, dbNowMs: MON + 73 * HOUR, floorMs: FLOOR, lastServedMs: LAST_MON })
    expect(plan.fires).toEqual([])
    expect(plan.missed).toEqual({ scheduled_for: MON, reason: 'outside_catch_up_window' })
  })

  it('a daily slot inside an outage is reported missed when the schedule does not catch up', () => {
    const plan = planFires({ workflowId: 'wf-a', schedule: dailyTen, dbNowMs: TEN_EST + 2 * HOUR, floorMs: FLOOR, lastServedMs: TEN_EST - 24 * HOUR })
    expect(plan).toEqual({ fires: [], missed: { scheduled_for: TEN_EST, reason: 'catch_up_none' } })
  })

  it('reports only the LATEST missed slot, never every one (the P9 volume)', () => {
    const every5: ScheduleConfig = { cron: '*/5 * * * *', timezone: 'UTC', overlap: 'skip', catch_up: 'none', jitter_max_seconds: 0 }
    const now = Date.UTC(2027, 0, 5, 18, 2, 48)
    const plan = planFires({ workflowId: 'wf-c', schedule: every5, dbNowMs: now, floorMs: FLOOR, lastServedMs: Date.UTC(2027, 0, 5, 12, 0) })
    expect(slots(plan.fires)).toEqual(['2027-01-05T18:00:00.000Z'])
    expect(plan.missed).toEqual({ scheduled_for: Date.UTC(2027, 0, 5, 17, 55), reason: 'catch_up_none' })
  })

  it('does not catch up an earlier slot when a due one is firing now: the due run carries the last served slot to cover the gap', () => {
    const frequentLatest: ScheduleConfig = { cron: '0 * * * *', timezone: 'UTC', overlap: 'skip', catch_up: 'latest', catch_up_window_seconds: 1800, jitter_max_seconds: 0 }
    const now = Date.UTC(2027, 0, 5, 12, 0, 48)
    const plan = planFires({ workflowId: 'wf-h', schedule: frequentLatest, dbNowMs: now, floorMs: FLOOR, lastServedMs: Date.UTC(2027, 0, 5, 10, 0) })
    expect(plan.fires).toEqual([{ scheduled_for: Date.UTC(2027, 0, 5, 12, 0), dispatch_at: Date.UTC(2027, 0, 5, 12, 0), reason: 'due', previous_scheduled_for: Date.UTC(2027, 0, 5, 10, 0) }])
    expect(plan.missed).toEqual({ scheduled_for: Date.UTC(2027, 0, 5, 11, 0), reason: 'superseded_by_due_fire' })
  })

  it('an interval that does not divide the hour catches up its latest missed slot', () => {
    const every45: ScheduleConfig = { interval_seconds: 2700, timezone: 'UTC', overlap: 'skip', catch_up: 'latest', catch_up_window_seconds: 1800, jitter_max_seconds: 0 }
    // Slots at 00:45, 01:30, 02:15. Back at 02:30:48: 02:15 is the latest missed, inside 30 minutes.
    const plan = planFires({ workflowId: 'wf-i', schedule: every45, dbNowMs: Date.UTC(2027, 0, 1, 2, 30, 48), floorMs: FLOOR, lastServedMs: Date.UTC(2027, 0, 1, 0, 45) })
    expect(plan.fires).toEqual([{ scheduled_for: Date.UTC(2027, 0, 1, 2, 15), dispatch_at: Date.UTC(2027, 0, 1, 2, 15), reason: 'catch_up', previous_scheduled_for: Date.UTC(2027, 0, 1, 0, 45) }])
  })
})

describe('planFires: a schedule across a New York daylight saving change', () => {
  it('fires the 02:04 slot the spring change skips once, at 03:04 EDT', () => {
    const s: ScheduleConfig = { cron: '4 2 * * *', timezone: NY, overlap: 'skip', catch_up: 'none', jitter_max_seconds: 0 }
    const shifted = Date.UTC(2027, 2, 14, 7, 4)
    let lastServed: number | null = Date.UTC(2027, 2, 13, 7, 4)
    const recorded: number[] = []
    for (let t = Date.UTC(2027, 2, 14, 5, 0, 48); t < Date.UTC(2027, 2, 14, 9, 0); t += MIN) {
      for (const f of planFires({ workflowId: 'wf-d', schedule: s, dbNowMs: t, floorMs: FLOOR, lastServedMs: lastServed }).fires) {
        recorded.push(f.scheduled_for)
        lastServed = f.scheduled_for
      }
    }
    expect(recorded).toEqual([shifted])
  })

  it('fires the 01:00 the autumn change repeats once', () => {
    const s: ScheduleConfig = { cron: '0 21,23,1,3,5 * * *', timezone: NY, overlap: 'skip', catch_up: 'none', jitter_max_seconds: 0 }
    let lastServed: number | null = Date.UTC(2027, 10, 7, 3, 0)
    const recorded: number[] = []
    for (let t = Date.UTC(2027, 10, 7, 4, 0, 48); t < Date.UTC(2027, 10, 7, 7, 30); t += MIN) {
      for (const f of planFires({ workflowId: 'wf-d', schedule: s, dbNowMs: t, floorMs: FLOOR, lastServedMs: lastServed }).fires) {
        recorded.push(f.scheduled_for)
        lastServed = f.scheduled_for
      }
    }
    expect(recorded.map(iso)).toEqual(['2027-11-07T05:00:00.000Z'])
  })
})

describe('planFires refuses inputs it cannot reason about', () => {
  it('throws with the reason for a stored schedule that no longer validates, so the tick can report it per schedule', () => {
    expect(() => planFires({ workflowId: 'wf-x', schedule: { ...dailyTen, cron: '0 10 * * 1' }, dbNowMs: TEN_EST, floorMs: FLOOR, lastServedMs: null })).toThrow(/cron_weekday_not_named/)
  })

  it('throws for a last served slot after the database clock, which means the clocks disagree', () => {
    expect(() => planFires({ workflowId: 'wf-a', schedule: dailyTen, dbNowMs: TEN_EST, floorMs: FLOOR, lastServedMs: TEN_EST + MIN })).toThrow(/after the database clock/)
  })

  it('throws for a time that is not a time', () => {
    expect(() => planFires({ workflowId: 'wf-a', schedule: dailyTen, dbNowMs: Number.NaN, floorMs: FLOOR, lastServedMs: null })).toThrow(/not a time/)
    expect(() => planFires({ workflowId: 'wf-a', schedule: dailyTen, dbNowMs: TEN_EST, floorMs: Number.POSITIVE_INFINITY, lastServedMs: null })).toThrow(/not a time/)
  })

  it('throws for an empty workflow id, which the jitter is derived from', () => {
    expect(() => planFires({ workflowId: '', schedule: dailyTen, dbNowMs: TEN_EST, floorMs: FLOOR, lastServedMs: null })).toThrow(/workflow id/)
  })
})

describe('jitterOffsetMs: deterministic per workflow (D7)', () => {
  it('is identical across calls, so across ticks and restarts, and whole seconds within the bound', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`)
    for (const id of ids) {
      const a = jitterOffsetMs(id, 60)
      expect(jitterOffsetMs(id, 60)).toBe(a)
      expect(a % 1000).toBe(0)
      expect(a).toBeGreaterThanOrEqual(0)
      expect(a).toBeLessThanOrEqual(60_000)
    }
    // It spreads: 200 workflows do not all land on one second.
    expect(new Set(ids.map((id) => jitterOffsetMs(id, 60))).size).toBeGreaterThan(40)
  })

  it('is zero when the schedule sets no jitter', () => {
    expect(jitterOffsetMs('any-workflow', 0)).toBe(0)
  })

  it('moves dispatch, never the nominal slot dedup and catch up key on', () => {
    const plan = planFires({ workflowId: 'wf-a', schedule: { ...dailyTen, jitter_max_seconds: 60 }, dbNowMs: TEN_EST + 48_000, floorMs: FLOOR, lastServedMs: null })
    expect(plan.fires[0].scheduled_for).toBe(TEN_EST)
    expect(plan.fires[0].dispatch_at).toBe(TEN_EST + jitterOffsetMs('wf-a', 60))
  })
})

describe('scheduleFloorMs: no fire before the schedule existed here (D8)', () => {
  it('is when the schedule became known, for a schedule born in Bidspoke', () => {
    expect(scheduleFloorMs({ knownSinceMs: TEN_EST })).toBe(TEN_EST)
  })

  it('is the cutover pause instant for a ported workflow, when that is later', () => {
    expect(scheduleFloorMs({ knownSinceMs: TEN_EST, cutoverAtMs: TEN_EST + HOUR })).toBe(TEN_EST + HOUR)
  })

  it('is no earlier than the last slot the workflow it replaces served, so a new id cannot re-fire it', () => {
    // A converter rerun mints a new workflow id at 10:30, after the old id served 10:00.
    const lastServedByOld = TEN_EST
    const floor = scheduleFloorMs({ knownSinceMs: TEN_EST - 2 * HOUR, replacedLastServedMs: lastServedByOld })
    expect(floor).toBe(lastServedByOld)
    const plan = planFires({ workflowId: 'wf-new', schedule: dailyTen, dbNowMs: TEN_EST + 2 * MIN + 48_000, floorMs: floor, lastServedMs: null })
    expect(plan.fires).toEqual([])
  })

  it('refuses a floor input that is not a time', () => {
    expect(() => scheduleFloorMs({ knownSinceMs: Number.NaN })).toThrow(/not a time/)
  })
})
