/**
 * Achieve leads skipped for lack of time are counted per day and paged above a
 * measured rate (#2862, L77).
 *
 * The Achieve step sends nothing when too little of the 12 s after the answer is
 * left (`answer_window_spent`, #2834). That was only a step output and a log line,
 * so a day when slow steps before Achieve cost it many leads paged nobody. Each
 * hourly run judges the last Eastern day that has ended, once: the skips against
 * the leads the screen let through.
 *
 * Every clock is set, never waited on (L290).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ACHIEVE_WINDOW_SKIP_RULE,
  ACHIEVE_WINDOW_SKIPS_JOB,
  ACHIEVE_WINDOW_SKIPS_OBSERVE_FOR_MS,
  ACHIEVE_WINDOW_SKIPS_OBSERVING_SINCE_KEY,
  ACHIEVE_WINDOW_SKIPS_REMEDY,
  achieveWindowSkipsEnding,
  judgeWindowSkips,
  judgedDayKey,
  productionWindowSkipsDeps,
  runAchieveWindowSkips,
  type WindowSkipCounts,
  type WindowSkipsDeps,
} from '../achieve-window-skips'
import { ACHIEVE_WINDOW_SPENT_REASON } from '../../engine/nodes/achieve-offers'
import type { Env } from '../../index'

const DAY_MS = 24 * 3_600_000
// 9 AM ET on Friday 2026-10-30: the last Eastern day that has ended is Thursday the 29th.
const NOW = Date.parse('2026-10-30T13:00:00.000Z')
const THU_START = Date.parse('2026-10-29T04:00:00.000Z')
const FRI_START = Date.parse('2026-10-30T04:00:00.000Z')

function memoryKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
    delete: vi.fn(async (key: string) => { store.delete(key) }),
  }
}

/** Past the observe week: observing since well before NOW. */
const observedLongAgo = () => ({ [ACHIEVE_WINDOW_SKIPS_OBSERVING_SINCE_KEY]: String(NOW - 30 * DAY_MS) })

function deps(over: Partial<WindowSkipsDeps> & { counts?: WindowSkipCounts } = {}) {
  const kv = over.kv ?? memoryKv(observedLongAgo())
  const countDay = over.countDay ?? vi.fn(async () => over.counts ?? { sent: 140, skipped: 0 })
  const notify = over.notify ?? vi.fn(async () => {})
  const log = vi.fn()
  const d: WindowSkipsDeps = { kv, countDay, notify, now: () => NOW, localDev: false, log, ...over }
  return { d, kv: kv as ReturnType<typeof memoryKv>, countDay, notify, log }
}

describe('judgeWindowSkips', () => {
  it('is unmeasured when no lead passed the screen, as while Achieve is paused', () => {
    expect(judgeWindowSkips({ sent: 0, skipped: 0 })).toMatchObject({ verdict: 'unmeasured' })
  })

  it('is clean at the worst measured day and below the minimum count', () => {
    // The worst day measured (Oct 29) would have skipped about 1 in 115.
    expect(judgeWindowSkips({ sent: 145, skipped: 1 })).toMatchObject({ verdict: 'clean' })
    expect(judgeWindowSkips({ sent: 140, skipped: 7 })).toMatchObject({ verdict: 'clean' })
    // Two of two is a saturated share but under the minimum count.
    expect(judgeWindowSkips({ sent: 0, skipped: 2 })).toMatchObject({ verdict: 'clean' })
  })

  it('is elevated once the skips reach the minimum count and pass the share', () => {
    expect(ACHIEVE_WINDOW_SKIP_RULE).toEqual({ minSkips: 3, maxShare: 0.05 })
    expect(judgeWindowSkips({ sent: 140, skipped: 8 })).toMatchObject({ verdict: 'elevated' })
    // Saturated: every lead the screen let through was skipped.
    expect(judgeWindowSkips({ sent: 0, skipped: 3 })).toMatchObject({ verdict: 'elevated' })
    // Exactly 5% is not above it.
    expect(judgeWindowSkips({ sent: 95, skipped: 5 })).toMatchObject({ verdict: 'clean' })
  })
})

describe('runAchieveWindowSkips', () => {
  it('counts the last Eastern day that has ended, from its Eastern midnight to the next', async () => {
    const { d, countDay } = deps()
    const s = await runAchieveWindowSkips(d)
    expect(countDay).toHaveBeenCalledWith(THU_START, FRI_START)
    expect(s.day).toBe('2026-10-29')
  })

  it('pages the day in full sentences with its real numbers, keyed on the job so a new day reads as the same problem', async () => {
    const { d, notify, kv } = deps({ counts: { sent: 128, skipped: 12 } })
    const s = await runAchieveWindowSkips(d)
    expect(s.verdict).toMatchObject({ verdict: 'elevated' })
    expect(notify).toHaveBeenCalledTimes(1)
    const lines = (notify as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
    expect(lines).toEqual([
      'On Thu, Oct 29, 12 of the 140 leads that passed the Achieve screen (9%) were not sent to Achieve. Each reached the Achieve step with under 3 seconds left of the 12 seconds a run keeps working after it answers the lead, too little for Achieve to reply.',
    ])
    expect(kv.store.get(judgedDayKey('2026-10-29'))).toBeDefined()
  })

  it('clears a standing page on a clean day by telling the alerter there is nothing', async () => {
    const { d, notify } = deps({ counts: { sent: 140, skipped: 1 } })
    await runAchieveWindowSkips(d)
    expect(notify).toHaveBeenCalledWith([])
  })

  it('neither raises nor clears on a day no lead passed the screen', async () => {
    const { d, notify, kv } = deps({ counts: { sent: 0, skipped: 0 } })
    const s = await runAchieveWindowSkips(d)
    expect(s.verdict).toMatchObject({ verdict: 'unmeasured' })
    expect(notify).not.toHaveBeenCalled()
    expect(kv.store.get(judgedDayKey('2026-10-29'))).toBeDefined()
  })

  it('judges a day once: a later run that day reads the mark and counts nothing', async () => {
    const kv = memoryKv({ ...observedLongAgo(), [judgedDayKey('2026-10-29')]: String(NOW - 3_600_000) })
    const { d, countDay, notify } = deps({ kv })
    const s = await runAchieveWindowSkips(d)
    expect(s.skipped).toBe('already_judged')
    expect(countDay).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('does nothing in local dev', async () => {
    const { d, countDay } = deps({ localDev: true })
    expect((await runAchieveWindowSkips(d)).skipped).toBe('local_dev')
    expect(countDay).not.toHaveBeenCalled()
  })

  describe('the observe week (L36), started by the first day it measured', () => {
    it('does not start on a day nothing passed the screen, so a pause does not use the week up', async () => {
      const kv = memoryKv()
      const { d } = deps({ kv, counts: { sent: 0, skipped: 0 } })
      await runAchieveWindowSkips(d)
      expect(kv.store.has(ACHIEVE_WINDOW_SKIPS_OBSERVING_SINCE_KEY)).toBe(false)
    })

    it('starts on the first measured day and logs what it would page without paging', async () => {
      const kv = memoryKv()
      const { d, notify, log } = deps({ kv, counts: { sent: 128, skipped: 12 } })
      const s = await runAchieveWindowSkips(d)
      expect(kv.store.get(ACHIEVE_WINDOW_SKIPS_OBSERVING_SINCE_KEY)).toBe(String(NOW))
      expect(notify).not.toHaveBeenCalled()
      expect(s.observing_until).toBe(new Date(NOW + ACHIEVE_WINDOW_SKIPS_OBSERVE_FOR_MS).toISOString())
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`[${ACHIEVE_WINDOW_SKIPS_JOB}] would page (observing until`))
      expect(achieveWindowSkipsEnding(s)).toMatchObject({ outcome: 'findings', detail: expect.stringContaining('would page') })
    })

    it('pages once the week has passed', async () => {
      const kv = memoryKv({ [ACHIEVE_WINDOW_SKIPS_OBSERVING_SINCE_KEY]: String(NOW - ACHIEVE_WINDOW_SKIPS_OBSERVE_FOR_MS) })
      const { d, notify } = deps({ kv, counts: { sent: 128, skipped: 12 } })
      await runAchieveWindowSkips(d)
      expect(notify).toHaveBeenCalledTimes(1)
    })

    it('reads an unreadable start as none and starts the week again', async () => {
      const kv = memoryKv({ [ACHIEVE_WINDOW_SKIPS_OBSERVING_SINCE_KEY]: 'not a time' })
      const { d, notify } = deps({ kv, counts: { sent: 128, skipped: 12 } })
      await runAchieveWindowSkips(d)
      expect(kv.store.get(ACHIEVE_WINDOW_SKIPS_OBSERVING_SINCE_KEY)).toBe(String(NOW))
      expect(notify).not.toHaveBeenCalled()
    })
  })

  describe('failures', () => {
    it('a count that fails throws, so the run is counted as failed, nothing is paged or cleared, and the day is tried again next hour', async () => {
      const countDay = vi.fn(async () => { throw new Error('execution_steps achieve_offers skipped count: canceling statement due to statement timeout') })
      const { d, notify, kv } = deps({ countDay })
      await expect(runAchieveWindowSkips(d)).rejects.toThrow('statement timeout')
      expect(notify).not.toHaveBeenCalled()
      expect(kv.store.has(judgedDayKey('2026-10-29'))).toBe(false)
    })

    it('a page the alerter refuses throws, and the day is not marked judged, so the next run pages it again', async () => {
      const notify = vi.fn(async () => { throw new Error('Slack organizations could not be read') })
      const { d, kv } = deps({ notify, counts: { sent: 128, skipped: 12 } })
      await expect(runAchieveWindowSkips(d)).rejects.toThrow('Slack organizations could not be read')
      expect(kv.store.has(judgedDayKey('2026-10-29'))).toBe(false)
    })
  })
})

describe('achieveWindowSkipsEnding, the job_runs record', () => {
  it('records each day with its counts, so the daily rate can be re-measured later (L316)', async () => {
    const { d } = deps({ counts: { sent: 140, skipped: 1 } })
    const ending = achieveWindowSkipsEnding(await runAchieveWindowSkips(d))
    expect(ending).toMatchObject({ outcome: 'ok', summary: { day: '2026-10-29', counts: { sent: 140, skipped: 1 } } })
  })

  it('records a day nothing passed the screen as unmeasured, never as ok (L98)', async () => {
    const { d } = deps({ counts: { sent: 0, skipped: 0 } })
    expect(achieveWindowSkipsEnding(await runAchieveWindowSkips(d))).toMatchObject({ outcome: 'unmeasured' })
  })

  it('records an elevated day as findings', async () => {
    const { d } = deps({ counts: { sent: 128, skipped: 12 } })
    expect(achieveWindowSkipsEnding(await runAchieveWindowSkips(d))).toMatchObject({ outcome: 'findings' })
  })
})

describe('the page', () => {
  it('is a titled alert in plain words', () => {
    expect(ACHIEVE_WINDOW_SKIPS_REMEDY).toEqual({
      title: 'Achieve is missing leads because steps before it run slowly',
      context: 'Achieve never receives these leads. On a normal day fewer than 1 in 100 are skipped this way, so a step that runs before Achieve after the answer, most often a Salesforce write, has slowed down.',
      fixHint: 'Open one of the day\'s runs in Bidspoke and find the step before Achieve that took several seconds. A slow Salesforce write points to Salesforce, and a step added before Achieve may need to move after it.',
    })
  })
})

describe('productionWindowSkipsDeps.countDay', () => {
  function recordingSupabase(answers: { sent: { count: number | null; error: { message: string } | null }; skipped: { count: number | null; error: { message: string } | null } }) {
    const calls: Array<Array<[string, unknown[]]>> = []
    return {
      calls,
      from(table: string) {
        const chain: Array<[string, unknown[]]> = [['from', [table]]]
        calls.push(chain)
        const builder: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'gte', 'lt']) {
          builder[m] = (...args: unknown[]) => { chain.push([m, args]); return builder }
        }
        builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
          const which = chain.some(([m, a]) => m === 'eq' && a[0] === 'output->>reason') ? 'skipped' : 'sent'
          return Promise.resolve(answers[which]).then(resolve, reject)
        }
        return builder
      },
    }
  }

  const env = { IDEMPOTENCY: memoryKv(), LOCAL_DEV: undefined } as unknown as Env

  it('head counts live Achieve steps of the day by the stored marker and the stored skip reason', async () => {
    const supabase = recordingSupabase({ sent: { count: 140, error: null }, skipped: { count: 4, error: null } })
    const d = productionWindowSkipsDeps(supabase as never, env)
    expect(await d.countDay(THU_START, FRI_START)).toEqual({ sent: 140, skipped: 4 })
    expect(supabase.calls).toHaveLength(2)
    for (const chain of supabase.calls) {
      expect(chain).toContainEqual(['from', ['execution_steps']])
      expect(chain).toContainEqual(['select', ['id', { count: 'exact', head: true }]])
      expect(chain).toContainEqual(['eq', ['step_type', 'achieve_offers']])
      expect(chain).toContainEqual(['eq', ['is_test', false]])
      expect(chain).toContainEqual(['gte', ['started_at', new Date(THU_START).toISOString()]])
      expect(chain).toContainEqual(['lt', ['started_at', new Date(FRI_START).toISOString()]])
      // The partition bound, with slack for a run that began before the day did.
      expect(chain).toContainEqual(['gte', ['execution_started_at', new Date(THU_START - 10 * 60_000).toISOString()]])
    }
    expect(supabase.calls.flat()).toContainEqual(['eq', ['output->>reason', ACHIEVE_WINDOW_SPENT_REASON]])
    expect(supabase.calls.flat()).toContainEqual(['eq', ['output->>_achieve_evaluation', 'true']])
  })

  it('refuses a count that errored or came back empty, never reading it as zero (L90)', async () => {
    const failed = recordingSupabase({ sent: { count: 140, error: null }, skipped: { count: null, error: { message: 'canceling statement due to statement timeout' } } })
    await expect(productionWindowSkipsDeps(failed as never, env).countDay(THU_START, FRI_START)).rejects.toThrow('skipped count: canceling statement due to statement timeout')
    const empty = recordingSupabase({ sent: { count: null, error: null }, skipped: { count: 0, error: null } })
    await expect(productionWindowSkipsDeps(empty as never, env).countDay(THU_START, FRI_START)).rejects.toThrow('sent count came back empty')
  })
})
