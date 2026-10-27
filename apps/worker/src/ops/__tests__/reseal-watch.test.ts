/**
 * The reseal watch (#2486): how the minute tick judges an ops key reseal that
 * keeps leaving logins on the old key, or a switch left on after it finished,
 * from OPS_RESEAL and the state the ops database keeps (observe_ops_reseal).
 * What the bidding Worker pages from the verdict is ops-key-reseal.test.ts's.
 */
import { describe, expect, it } from 'vitest'
import {
  RESEAL_LEFT_BEHIND_PAGE_MS, RESEAL_LEFT_ON_PAGE_MS, RESEAL_RESTART_AFTER_MS, judgeReseal, resealSwitchFrom, watchReseal,
} from '../reseal-watch'
import type { OpsResealState } from '../ops-writes'

const DB_NOW = '2026-10-27T16:00:00.000Z'
const at = (msBefore: number) => new Date(Date.parse(DB_NOW) - msBefore).toISOString()
const MIN = 60_000

function state(over: Partial<OpsResealState> = {}): OpsResealState {
  return {
    mode: 'apply', modeSince: at(10 * MIN), lastRunAt: at(MIN), lastRunNothingLeft: false, lastRunLeft: 3, nothingLeftSince: null, restarted: false, dbNow: DB_NOW,
    ...over,
  }
}

describe('the bounds', () => {
  it('pages a reseal that leaves logins behind for 2 hours, a switch left on 2 hours after it finished, and restarts after 10 minutes unseen', () => {
    expect(RESEAL_LEFT_BEHIND_PAGE_MS).toBe(2 * 60 * MIN)
    expect(RESEAL_LEFT_ON_PAGE_MS).toBe(2 * 60 * MIN)
    expect(RESEAL_RESTART_AFTER_MS).toBe(10 * MIN)
  })
})

describe('resealSwitchFrom, what OPS_RESEAL says', () => {
  it('reads unset or blank as off, preview and apply as on, trimmed, and anything else as unknown', () => {
    for (const raw of [undefined, '', '  ']) expect(resealSwitchFrom(raw)).toEqual({ kind: 'off' })
    expect(resealSwitchFrom('preview')).toEqual({ kind: 'on', mode: 'preview' })
    expect(resealSwitchFrom(' apply ')).toEqual({ kind: 'on', mode: 'apply' })
    for (const raw of ['yes', 'APPLY', 'aply', 'true']) expect(resealSwitchFrom(raw)).toEqual({ kind: 'unknown' })
  })
})

describe('judgeReseal', () => {
  const off = { kind: 'off' } as const
  const apply = { kind: 'on', mode: 'apply' } as const
  const preview = { kind: 'on', mode: 'preview' } as const

  it('says off when the switch is unset, and switch_unknown when it names no mode, with nothing from the database', () => {
    expect(judgeReseal(off, null)).toEqual({ verdict: 'off', mode: null, since: null, nothing_left_since: null, last_run_at: null, last_run_left: null, db_now: null })
    expect(judgeReseal({ kind: 'unknown' }, null)).toEqual({ verdict: 'switch_unknown', mode: null, since: null, nothing_left_since: null, last_run_at: null, last_run_left: null, db_now: null })
  })

  it('says running while apply has been on for less than 2 hours, and logins_left from 2 hours with no run that left nothing', () => {
    expect(judgeReseal(apply, state({ modeSince: at(RESEAL_LEFT_BEHIND_PAGE_MS - 1) })).verdict).toBe('running')
    expect(judgeReseal(apply, state({ modeSince: at(RESEAL_LEFT_BEHIND_PAGE_MS) }))).toEqual({
      verdict: 'logins_left', mode: 'apply', since: at(RESEAL_LEFT_BEHIND_PAGE_MS), nothing_left_since: null, last_run_at: at(MIN), last_run_left: 3, db_now: DB_NOW,
    })
  })

  it('counts a reseal whose runs failed, or never recorded, as leaving logins, since none said every login moved', () => {
    expect(judgeReseal(apply, state({ modeSince: at(3 * 60 * MIN), lastRunAt: null, lastRunNothingLeft: null, lastRunLeft: null })).verdict).toBe('logins_left')
    expect(judgeReseal(apply, state({ modeSince: at(3 * 60 * MIN), lastRunLeft: null })).verdict).toBe('logins_left')
  })

  it('says preview_left_on for a preview on 2 hours that still has logins to move', () => {
    expect(judgeReseal(preview, state({ mode: 'preview', modeSince: at(RESEAL_LEFT_BEHIND_PAGE_MS - 1) })).verdict).toBe('running')
    expect(judgeReseal(preview, state({ mode: 'preview', modeSince: at(RESEAL_LEFT_BEHIND_PAGE_MS) })).verdict).toBe('preview_left_on')
  })

  it('says running for 2 hours after a run left nothing, then finished_left_on, in either mode, however long the switch has been on', () => {
    const finished = (msAgo: number) => state({ modeSince: at(30 * 60 * MIN), lastRunNothingLeft: true, lastRunLeft: 0, nothingLeftSince: at(msAgo) })
    expect(judgeReseal(apply, finished(RESEAL_LEFT_ON_PAGE_MS - 1)).verdict).toBe('running')
    expect(judgeReseal(apply, finished(RESEAL_LEFT_ON_PAGE_MS))).toEqual({
      verdict: 'finished_left_on', mode: 'apply', since: at(30 * 60 * MIN), nothing_left_since: at(RESEAL_LEFT_ON_PAGE_MS), last_run_at: at(MIN), last_run_left: 0, db_now: DB_NOW,
    })
    expect(judgeReseal(preview, { ...finished(RESEAL_LEFT_ON_PAGE_MS), mode: 'preview' }).verdict).toBe('finished_left_on')
  })

  it('judges by the database clock it was given, never the Worker\'s', () => {
    // Two hours by the database, whatever this machine's clock says.
    expect(judgeReseal(apply, state({ modeSince: '2026-10-27T14:00:00.000Z', dbNow: '2026-10-27T16:00:00.000Z' })).verdict).toBe('logins_left')
    expect(judgeReseal(apply, state({ modeSince: '2026-10-27T14:00:00.000Z', dbNow: '2026-10-27T15:59:59.999Z' })).verdict).toBe('running')
  })
})

describe('watchReseal, the tick\'s step', () => {
  it('asks the database nothing while the switch is off or unknown', async () => {
    const asked: string[] = []
    const observe = async (mode: string) => { asked.push(mode); return state() }
    expect((await watchReseal({ kind: 'off' }, observe)).report?.verdict).toBe('off')
    expect((await watchReseal({ kind: 'unknown' }, observe)).report?.verdict).toBe('switch_unknown')
    expect(asked).toEqual([])
  })

  it('observes the switch in its mode, with the restart window in seconds, and judges the answer', async () => {
    const asked: Array<[string, number]> = []
    const r = await watchReseal({ kind: 'on', mode: 'apply' }, async (mode, seconds) => { asked.push([mode, seconds]); return state({ modeSince: at(3 * 60 * MIN) }) })
    expect(asked).toEqual([['apply', 600]])
    expect(r).toEqual({ report: expect.objectContaining({ verdict: 'logins_left' }), problem: null })
  })

  it('judges nothing with no database, which the tick pages as not configured, never reading it as off', async () => {
    expect(await watchReseal({ kind: 'on', mode: 'apply' }, null)).toEqual({ report: null, problem: null })
  })

  it('reports a failed read as a problem the bidding Worker holds for three ticks, and judges nothing', async () => {
    const r = await watchReseal({ kind: 'on', mode: 'apply' }, async () => { throw new Error('observe_ops_reseal did not answer within 9000 ms') })
    expect(r.report).toBeNull()
    expect(r.problem).toEqual({
      key: 'reseal_state_failed',
      text: 'The ops tick could not read how long the ops key reseal has been switched on (observe_ops_reseal did not answer within 9000 ms), so whether it is leaving logins on the old key is not known.',
    })
  })
})
