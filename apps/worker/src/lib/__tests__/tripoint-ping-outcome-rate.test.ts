/**
 * Tripoint's outcome rate on the Engine tripoint_ping path (#2392), a bridge
 * until #1414 moves those leads onto buyer_select and buyer-outcome-rate.
 *
 * The hourly figures below are MEASURED, read on 2026-10-18 from the Engine
 * Bidding Workflow's tripoint_ping steps (execution_steps, is_test false, by
 * Eastern clock hour of started_at), with each answer classed the way the
 * buyer_select node classes Tripoint's (declined, in_progress, invalid_data and
 * null_id_fault are a decline; unknown is a failure; skipped is not a send).
 * Columns: Eastern hour, accepted, declined, failed, sent.
 *
 * Tripoint stopped accepting loans under $2,000 at 10:22 PM ET on 2026-10-13
 * and nothing alerted. The Oct 14 hours must page; the Oct 16 and 17 hours,
 * after the Engine minimum stopped those sends, must not.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import { judgeOutcomeShares, type OutcomeBaseline } from '../outcome-rate-rule'
import {
  TRIPOINT_PING_OUTCOME_RATE_JOB,
  TRIPOINT_PING_OUTCOME_RATE_REMEDY,
  TRIPOINT_PING_RULE,
  TRIPOINT_SENT_ANSWERS_EXCLUDED,
  hourKey,
  dayKey,
  pingCountsFrom,
  runTripointPingOutcomeRate,
  endingOf,
  productionPingDeps,
  type PingCounts,
  type PingDeps,
} from '../tripoint-ping-outcome-rate'
import { ENGINE_BIDDING_WORKFLOW_ID, KEPT_ENGINE_SCRIPTS } from '../engine-script-drift'

type Row = readonly [hour: string, accepted: number, declined: number, failed: number, sent: number]

const OCT_13_NIGHT_AND_OCT_14: Row[] = [
  ['10-13 22', 47, 59, 0, 106], ['10-13 23', 34, 49, 0, 83],
  ['10-14 00', 23, 51, 0, 74], ['10-14 01', 18, 42, 0, 60], ['10-14 02', 13, 40, 0, 53], ['10-14 03', 13, 25, 0, 38],
  ['10-14 04', 12, 31, 0, 43], ['10-14 05', 21, 32, 0, 53], ['10-14 06', 17, 40, 0, 57], ['10-14 07', 29, 63, 0, 92],
  ['10-14 08', 33, 77, 0, 110], ['10-14 09', 52, 108, 0, 160], ['10-14 10', 65, 113, 0, 178], ['10-14 11', 70, 123, 0, 193],
  ['10-14 12', 74, 151, 0, 225], ['10-14 13', 68, 127, 0, 195], ['10-14 14', 72, 134, 1, 207], ['10-14 15', 73, 120, 0, 193],
  ['10-14 16', 62, 128, 0, 190], ['10-14 17', 60, 114, 0, 174], ['10-14 18', 53, 98, 0, 151], ['10-14 19', 54, 115, 0, 169],
  ['10-14 20', 56, 96, 0, 152], ['10-14 21', 40, 92, 0, 132], ['10-14 22', 37, 87, 0, 124], ['10-14 23', 25, 72, 0, 97],
]

const OCT_16: Row[] = [
  ['10-16 00', 34, 13, 0, 47], ['10-16 01', 21, 23, 0, 44], ['10-16 02', 13, 17, 0, 30], ['10-16 03', 11, 12, 0, 23],
  ['10-16 04', 14, 11, 0, 25], ['10-16 05', 21, 10, 0, 31], ['10-16 06', 17, 11, 0, 28], ['10-16 07', 26, 22, 0, 48],
  ['10-16 08', 35, 18, 0, 53], ['10-16 09', 63, 36, 0, 99], ['10-16 10', 55, 39, 0, 94], ['10-16 11', 76, 41, 0, 117],
  ['10-16 12', 86, 55, 0, 141], ['10-16 13', 66, 43, 0, 109], ['10-16 14', 63, 39, 0, 102], ['10-16 15', 77, 41, 0, 118],
  ['10-16 16', 64, 64, 0, 128], ['10-16 17', 53, 45, 0, 98], ['10-16 18', 59, 35, 0, 94], ['10-16 19', 43, 33, 0, 76],
  ['10-16 20', 36, 27, 0, 63], ['10-16 21', 34, 19, 0, 53], ['10-16 22', 27, 33, 0, 60], ['10-16 23', 25, 20, 0, 45],
]

const OCT_17: Row[] = [
  ['10-17 00', 19, 21, 0, 40], ['10-17 01', 17, 18, 0, 35], ['10-17 02', 17, 8, 0, 25], ['10-17 03', 14, 6, 0, 20],
  ['10-17 04', 23, 8, 0, 31], ['10-17 05', 7, 5, 0, 12], ['10-17 06', 17, 12, 0, 29], ['10-17 07', 24, 15, 0, 39],
  ['10-17 08', 29, 13, 0, 42], ['10-17 09', 33, 28, 0, 61], ['10-17 10', 49, 24, 0, 73], ['10-17 11', 60, 25, 0, 85],
  ['10-17 12', 45, 32, 0, 77], ['10-17 13', 69, 37, 0, 106], ['10-17 14', 50, 30, 0, 80], ['10-17 15', 50, 16, 0, 66],
  ['10-17 16', 35, 45, 0, 80], ['10-17 17', 39, 27, 0, 66], ['10-17 18', 23, 24, 0, 47], ['10-17 19', 35, 24, 0, 59],
  ['10-17 20', 23, 24, 0, 47], ['10-17 21', 25, 30, 0, 55], ['10-17 22', 30, 19, 0, 49], ['10-17 23', 22, 9, 0, 31],
]

/**
 * Measured whole Eastern days (sent, declined, failed): Oct 11 2,411 / 1,004 / 0,
 * Oct 12 2,860 / 1,190 / 0, Oct 13 3,106 / 1,347 / 1, Oct 14 3,120 / 2,079 / 1,
 * Oct 15 2,622 / 1,322 / 0, Oct 16 1,726 / 707 / 0. execution_steps held nothing
 * before Oct 11, so each baseline is the retained part of its 14 days.
 */
const BASELINE_FOR_OCT_14: OutcomeBaseline = { attempts: 8_377, declined: 3_541, failed: 1 }
const BASELINE_FOR_OCT_16: OutcomeBaseline = { attempts: 14_119, declined: 6_942, failed: 2 }
const BASELINE_FOR_OCT_17: OutcomeBaseline = { attempts: 15_845, declined: 7_649, failed: 2 }
/** The lowest whole day decline share measured (Oct 17, 500 of 1,255): the strictest baseline a quiet day meets. */
const STRICT_BASELINE: OutcomeBaseline = { attempts: 10_000, declined: 4_000, failed: 0 }

const judge = (r: Row, baseline: OutcomeBaseline) => judgeOutcomeShares({ attempts: r[4], declined: r[2], failed: r[3] }, baseline, TRIPOINT_PING_RULE)

describe('the measured Oct 14 shape pages and the Oct 16 and 17 shapes do not', () => {
  it('Oct 14: the hour starting at midnight ET, 98 minutes after Tripoint stopped taking small loans, is the first to page, and most busy hours page', () => {
    const verdicts = OCT_13_NIGHT_AND_OCT_14.map((r) => [r[0], judge(r, BASELINE_FOR_OCT_14).verdict] as const)
    const elevated = verdicts.filter(([, v]) => v === 'elevated').map(([h]) => h)
    expect(elevated[0]).toBe('10-14 00')
    expect(verdicts.find(([h]) => h === '10-13 22')?.[1]).toBe('normal')
    // 13 of the 23 hours with enough sends to judge. The rest sit 18 to 25
    // points above the baseline, close under the line; one quiet hour (03 ET,
    // 38 sends) is below the floor.
    expect(elevated.length).toBeGreaterThanOrEqual(12)
    expect(verdicts.find(([h]) => h === '10-14 03')?.[1]).toBe('quiet')
  })

  it('Oct 14: the page names the declines and both shares', () => {
    const v = judge(OCT_13_NIGHT_AND_OCT_14[2], BASELINE_FOR_OCT_14)
    expect(v).toMatchObject({ verdict: 'elevated', detail: expect.stringMatching(/51 of 74 attempts in the last hour were declined by the buyer, 69% against 42%/) })
  })

  it.each([
    ['Oct 16', OCT_16, BASELINE_FOR_OCT_16],
    ['Oct 17', OCT_17, BASELINE_FOR_OCT_17],
  ])('%s: no hour pages against its trailing baseline', (_day, rows, baseline) => {
    for (const r of rows) expect(judge(r, baseline).verdict, r[0]).not.toBe('elevated')
  })

  it('Oct 16 and 17: no hour pages even against the lowest decline share any measured day had', () => {
    for (const r of [...OCT_16, ...OCT_17]) expect(judge(r, STRICT_BASELINE).verdict, r[0]).not.toBe('elevated')
  })
})

describe('the floor and saturation (L716, L139)', () => {
  const base = BASELINE_FOR_OCT_14

  it('fewer sends than the floor are quiet even at a high decline share; at the floor they are judged', () => {
    const min = TRIPOINT_PING_RULE.minAttempts
    expect(min).toBe(40)
    const under = judgeOutcomeShares({ attempts: min - 1, declined: min - 10, failed: 0 }, base, TRIPOINT_PING_RULE)
    expect(under).toMatchObject({ verdict: 'quiet', detail: expect.stringMatching(new RegExp(`${min - 1} attempts in the last hour, fewer than the ${min} a rate needs`)) })
    expect(judgeOutcomeShares({ attempts: min, declined: min - 9, failed: 0 }, base, TRIPOINT_PING_RULE).verdict).toBe('elevated')
  })

  it('below the floor, an hour in which Tripoint accepted nothing is still a finding once it holds enough sends', () => {
    const n = TRIPOINT_PING_RULE.noAcceptSaturationMinAttempts as number
    expect(n).toBe(12)
    expect(judgeOutcomeShares({ attempts: n, declined: n, failed: 0 }, base, TRIPOINT_PING_RULE)).toMatchObject({
      verdict: 'elevated',
      detail: expect.stringMatching(new RegExp(`none of the ${n} attempts in the last hour was accepted`)),
    })
    expect(judgeOutcomeShares({ attempts: n - 1, declined: n - 1, failed: 0 }, base, TRIPOINT_PING_RULE)).toMatchObject({
      verdict: 'quiet',
      detail: expect.stringMatching(new RegExp(`none was accepted, fewer than the ${n}`)),
    })
  })

  it('every send failing is a finding from three sends, as for every buyer', () => {
    expect(judgeOutcomeShares({ attempts: 3, declined: 0, failed: 3 }, base, TRIPOINT_PING_RULE).verdict).toBe('elevated')
  })

  it('needs a baseline of 1,000 sends, and says how much it holds when it has fewer', () => {
    const thin: OutcomeBaseline = { attempts: 999, declined: 400, failed: 0, span: '9 recorded hours of the prior 14 days' }
    expect(judgeOutcomeShares({ attempts: 100, declined: 90, failed: 0 }, thin, TRIPOINT_PING_RULE)).toMatchObject({
      verdict: 'unmeasured',
      reason: expect.stringMatching(/9 recorded hours of the prior 14 days holds 999 attempts, fewer than the 1000/),
    })
  })
})

describe('pingCountsFrom: skipped is not a send', () => {
  it('a skipped step counts in neither the sends nor any share, and anything not accepted, declined or skipped is a failure', () => {
    expect(TRIPOINT_SENT_ANSWERS_EXCLUDED).toEqual(['skipped'])
    expect(pingCountsFrom({ total: 1_500, skipped: 1_200, accepted: 180, declined: 115 })).toEqual({ sent: 300, accepted: 180, declined: 115, failed: 5 })
  })
  it('counts that do not add up are refused, never judged', () => {
    expect(() => pingCountsFrom({ total: 100, skipped: 90, accepted: 8, declined: 5 })).toThrow(/do not add up/)
  })
})

// ── The run ────────────────────────────────────────────────────────────────────

const HOUR = 3_600_000
// 2026-10-14 13:20 UTC is 09:20 ET, an Eastern day of Oct 14.
const NOW = Date.UTC(2026, 9, 14, 13, 20)

function fakeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string, _o?: { expirationTtl?: number }) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  }
}

/** Seed one recorded hour per clock hour of the 14 Eastern days before NOW's day. */
function seedBaseline(kv: ReturnType<typeof fakeKv>, perHour: PingCounts, hours?: number[]) {
  const dayStart = Date.UTC(2026, 9, 14, 4) // midnight ET on Oct 14 (EDT)
  const from = dayStart - 14 * 24 * HOUR
  const all = Array.from({ length: 14 * 24 }, (_, i) => Math.floor(from / HOUR) + i)
  for (const h of hours ?? all) kv.store.set(hourKey(h), JSON.stringify(perHour))
}

type TestDeps = PingDeps & { kv: ReturnType<typeof fakeKv>; asked: Array<[number, number]>; notify: ReturnType<typeof vi.fn> }

function deps(over: Partial<PingDeps> = {}, counts: (from: number, to: number) => PingCounts = () => ({ sent: 160, accepted: 52, declined: 108, failed: 0 })): TestDeps {
  const kv = fakeKv()
  const asked: Array<[number, number]> = []
  return {
    kv,
    asked,
    countSends: async (from: number, to: number) => { asked.push([from, to]); return counts(from, to) },
    notify: vi.fn(async (_lines: string[]) => {}),
    now: () => NOW,
    localDev: false,
    appUrl: 'https://app.example',
    log: () => {},
    ...over,
  } as TestDeps
}

const HEALTHY_HOUR: PingCounts = { sent: 60, accepted: 35, declined: 25, failed: 0 }

describe('runTripointPingOutcomeRate', () => {
  it('pages one line naming Tripoint, the tripoint_ping path, the accepted share and the partner page when the last hour is elevated', async () => {
    const d = deps()
    seedBaseline(d.kv, HEALTHY_HOUR)
    const s = await runTripointPingOutcomeRate(d)
    expect(s.verdict.verdict).toBe('elevated')
    expect(d.notify).toHaveBeenCalledTimes(1)
    const lines = d.notify.mock.calls[0][0] as string[]
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^tripoint on the Engine Bidding tripoint_ping step: /)
    expect(lines[0]).toMatch(/108 of 160 attempts in the last hour were declined by the buyer, 68% against 42% over 336 recorded hours of the prior 14 days/)
    expect(lines[0]).toMatch(/52 of the 160 sends were accepted, 33% against 58%/)
    expect(lines[0]).toMatch(/partners\?selected=tripoint/)
    expect(endingOf(s).outcome).toBe('findings')
  })

  it('a normal hour sends an empty page, which clears a standing one', async () => {
    const d = deps({}, () => ({ sent: 120, accepted: 70, declined: 50, failed: 0 }))
    seedBaseline(d.kv, HEALTHY_HOUR)
    const s = await runTripointPingOutcomeRate(d)
    expect(s.verdict.verdict).toBe('normal')
    expect(d.notify).toHaveBeenCalledWith([])
    expect(endingOf(s).outcome).toBe('ok')
  })

  it('judges the hour ending two minutes ago, so steps still being written are not read as missing', async () => {
    const d = deps()
    seedBaseline(d.kv, HEALTHY_HOUR)
    await runTripointPingOutcomeRate(d)
    expect(d.asked).toContainEqual([NOW - 2 * 60_000 - HOUR, NOW - 2 * 60_000])
  })

  it('records each finished clock hour once, in KV, and a second run reads it back rather than asking again', async () => {
    const d = deps()
    seedBaseline(d.kv, HEALTHY_HOUR)
    await runTripointPingOutcomeRate(d)
    const thisHour = Math.floor(NOW / HOUR)
    for (const h of [thisHour - 3, thisHour - 2, thisHour - 1]) expect(d.kv.store.has(hourKey(h)), hourKey(h)).toBe(true)
    expect(d.kv.store.has(hourKey(thisHour))).toBe(false)
    const hourReads = d.asked.filter(([f, t]) => t - f === HOUR && f % HOUR === 0)
    expect(hourReads).toHaveLength(3)
    d.asked.length = 0
    await runTripointPingOutcomeRate(d)
    expect(d.asked.filter(([f, t]) => t - f === HOUR && f % HOUR === 0)).toHaveLength(0)
  })

  it('seals a whole past day into one KV entry once no more hours can be recorded for it', async () => {
    const d = deps()
    seedBaseline(d.kv, HEALTHY_HOUR)
    await runTripointPingOutcomeRate(d)
    expect(JSON.parse(d.kv.store.get(dayKey('2026-10-13')) as string)).toMatchObject({ attempts: 24 * 60, declined: 24 * 25, failed: 0, hours: 24 })
  })

  it('a baseline recorded for only some hours says how many it holds; one too thin is unmeasured and pages nothing', async () => {
    const d = deps()
    const dayStartHour = Math.floor(Date.UTC(2026, 9, 14, 4) / HOUR)
    seedBaseline(d.kv, HEALTHY_HOUR, [dayStartHour - 1, dayStartHour - 2])
    const s = await runTripointPingOutcomeRate(d)
    expect(s.verdict).toMatchObject({ verdict: 'unmeasured', reason: expect.stringMatching(/2 recorded hours of the prior 14 days holds 120 attempts/) })
    expect(d.notify).not.toHaveBeenCalled()
    expect(endingOf(s).outcome).toBe('unmeasured')
  })

  it('a window that cannot be read is unmeasured with the reason, and leaves any standing page alone', async () => {
    const d = deps({}, (from, to) => {
      if (to - from === HOUR && from % HOUR !== 0) throw new Error('execution_steps count timed out')
      return HEALTHY_HOUR
    })
    seedBaseline(d.kv, HEALTHY_HOUR)
    const s = await runTripointPingOutcomeRate(d)
    expect(s.verdict).toMatchObject({ verdict: 'unmeasured', reason: expect.stringMatching(/timed out/) })
    expect(d.notify).not.toHaveBeenCalled()
  })

  it('an hour that cannot be recorded is reported, and the run is not a pass even when the hour judged is normal', async () => {
    const d = deps({}, (from, to) => {
      if (from % HOUR === 0 && to - from === HOUR) throw new Error('statement timeout')
      return { sent: 120, accepted: 70, declined: 50, failed: 0 }
    })
    seedBaseline(d.kv, HEALTHY_HOUR)
    const s = await runTripointPingOutcomeRate(d)
    expect(s.verdict.verdict).toBe('normal')
    expect(s.rollup_errors.length).toBe(3)
    expect(endingOf(s)).toMatchObject({ outcome: 'unmeasured', detail: expect.stringMatching(/could not be recorded/) })
  })

  it('does nothing in local dev', async () => {
    const d = deps({ localDev: true })
    const s = await runTripointPingOutcomeRate(d)
    expect(s.skipped).toBe('local_dev')
    expect(d.notify).not.toHaveBeenCalled()
    expect(endingOf(s).outcome).toBe('skipped')
  })
})

describe('the bridge retires with tripoint_ping (#1414)', () => {
  it('stands only while the kept tripoint_ping script does: when #1414 removes the node, delete this check, its index.ts block and its CRON_JOBS entry', () => {
    const kept = KEPT_ENGINE_SCRIPTS.map((k) => k.namespace)
    expect(kept, 'tripoint_ping is no longer a kept Engine script, so retire the tripoint-ping-outcome-rate bridge').toContain('tripoint_ping')
  })
})

describe('the page wording', () => {
  it('has a distinct job name, says it reads tripoint_ping, and claims no window it may not have had', () => {
    expect(TRIPOINT_PING_OUTCOME_RATE_JOB).toBe('tripoint-ping-outcome-rate')
    const words = `${TRIPOINT_PING_OUTCOME_RATE_REMEDY.consequence} ${TRIPOINT_PING_OUTCOME_RATE_REMEDY.fixHint} ${TRIPOINT_PING_OUTCOME_RATE_REMEDY.headlineVerb}`
    expect(words).toMatch(/tripoint_ping/)
    expect(words).not.toMatch(/prior 14 days|than usual/)
  })
})

describe('productionPingDeps counts, never lists, the tripoint_ping steps', () => {
  /** A query double recording each filter, answering a head count by what was filtered on. */
  function countingDouble() {
    const queries: Array<Array<[string, ...unknown[]]>> = []
    const answers = { total: 1_500, skipped: 1_200, accepted: 180, declined: 115 }
    const supabase = {
      from: (table: string) => {
        const calls: Array<[string, ...unknown[]]> = [['from', table]]
        queries.push(calls)
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lt', 'not', 'filter']) b[m] = (...args: unknown[]) => { calls.push([m, ...args]); return b }
        b.then = (resolve: (v: unknown) => void) => {
          const answer = calls.find((c) => c[0] === 'eq' && c[1] === 'output->>tripoint_answer')
          const inAnswer = calls.find((c) => c[0] === 'in' && c[1] === 'output->>tripoint_answer')
          const count = answer?.[2] === 'skipped' ? answers.skipped : answer?.[2] === 'accepted' ? answers.accepted : inAnswer ? answers.declined : answers.total
          resolve({ data: null, count, error: null })
        }
        return b
      },
    } as unknown as SupabaseClient
    return { supabase, queries }
  }

  it('asks four head counts of the Engine workflow tripoint_ping steps, bounded on both started_at and the partition key', async () => {
    const fake = countingDouble()
    const from = Date.UTC(2026, 9, 14, 12)
    const to = from + HOUR
    const counts = await productionPingDeps(fake.supabase, { IDEMPOTENCY: fakeKv(), APP_URL: 'https://app.example' } as unknown as Env).countSends(from, to)
    expect(counts).toEqual({ sent: 300, accepted: 180, declined: 115, failed: 5 })
    expect(fake.queries).toHaveLength(4)
    for (const q of fake.queries) {
      expect(q[0]).toEqual(['from', 'execution_steps'])
      expect(q).toContainEqual(['select', 'id', { count: 'exact', head: true }])
      expect(q).toContainEqual(['eq', 'workflow_id', ENGINE_BIDDING_WORKFLOW_ID])
      expect(q).toContainEqual(['eq', 'step_namespace', 'tripoint_ping'])
      expect(q).toContainEqual(['eq', 'is_test', false])
      expect(q).toContainEqual(['gte', 'started_at', new Date(from).toISOString()])
      expect(q).toContainEqual(['lt', 'started_at', new Date(to).toISOString()])
      expect(q.some((c) => c[0] === 'gte' && c[1] === 'execution_started_at')).toBe(true)
      expect(q).toContainEqual(['lt', 'execution_started_at', new Date(to).toISOString()])
    }
    expect(fake.queries.some((q) => q.some((c) => c[0] === 'in' && c[1] === 'output->>tripoint_answer' && JSON.stringify(c[2]) === JSON.stringify(['declined', 'in_progress', 'invalid_data', 'null_id_fault'])))).toBe(true)
  })

  it('a count that errors is thrown with the table named, never read as zero', async () => {
    const supabase = {
      from: () => {
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lt']) b[m] = () => b
        b.then = (resolve: (v: unknown) => void) => resolve({ data: null, count: null, error: { message: 'canceling statement due to statement timeout' } })
        return b
      },
    } as unknown as SupabaseClient
    await expect(productionPingDeps(supabase, { IDEMPOTENCY: fakeKv(), APP_URL: 'x' } as unknown as Env).countSends(0, HOUR)).rejects.toThrow(/execution_steps.*statement timeout/)
  })
})
