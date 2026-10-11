/**
 * The strand-drain branch-skew check (#1133): catch a resolution branch that
 * takes effectively everything over a meaningful sample while another never
 * fires, which is the shape of a branch that cannot match (L551).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decideBranchSkew, recordAndCheckBranchSkew, SKEW_MIN_SAMPLE } from '../strand-branch-skew'
import { emptyBranchCounts, type StrandBranch } from '../stranded-executions'

vi.mock('../slack', () => ({
  getSlackConnection: vi.fn(),
  postMessage: vi.fn().mockResolvedValue('ts-1'),
}))
import { getSlackConnection, postMessage } from '../slack'

const counts = (over: Partial<Record<StrandBranch, number>>): Record<StrandBranch, number> => ({ ...emptyBranchCounts(), ...over })

describe('decideBranchSkew (#1133)', () => {
  it('stays quiet below the minimum sample, however lopsided', () => {
    expect(decideBranchSkew(counts({ unresolved: 10 })).skewed).toBe(false)
  })

  it('flags one branch taking everything while others never fired (the #1112 shape)', () => {
    const v = decideBranchSkew(counts({ unresolved: 119 }))
    expect(v.skewed).toBe(true)
    expect(v.reason).toMatch(/unresolved/)
    expect(v.reason).toMatch(/graph_dead_end/)
  })

  it('stays quiet when every branch has fired at least once, even with heavy dominance', () => {
    // 196 of 200 down one branch, but the other three each fired: not a dead branch.
    const v = decideBranchSkew(counts({ unresolved: 194, graph_dead_end: 2, failed_step: 2, sighting_outcome: 2 }))
    expect(v.skewed).toBe(false)
  })

  it('stays quiet when the top branch is below the dominance share', () => {
    // 60/100 is lopsided but not "effectively everything"; the rest are alive.
    const v = decideBranchSkew(counts({ unresolved: 60, graph_dead_end: 40 }))
    expect(v.skewed).toBe(false)
  })

  it('flags a dead branch even when a second branch fired a little, if a third is still at zero', () => {
    // 99 unresolved, 1 sighting_outcome, graph_dead_end and failed_step at zero.
    const v = decideBranchSkew(counts({ unresolved: 99, sighting_outcome: 1 }))
    expect(v.skewed).toBe(true)
    expect(v.reason).toMatch(/graph_dead_end/)
    expect(v.reason).toMatch(/failed_step/)
  })
})

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  }
}

const supa = {
  from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [{ organization_id: 'org-1' }], error: null }) }) }),
} as never

const slackOn = { bot_token: 't', default_channel: '#alerts', config_alerts_enabled: true }

describe('recordAndCheckBranchSkew (#1133)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSlackConnection).mockResolvedValue(slackOn as never)
    vi.mocked(postMessage).mockResolvedValue('ts-1')
  })

  it('accumulates across runs and stays silent until the sample is meaningful', async () => {
    const kv = fakeKv()
    // Ten runs of 4 unresolved each = 40, below the 50 floor.
    for (let i = 0; i < 10; i++) {
      expect(await recordAndCheckBranchSkew(kv, counts({ unresolved: 4 }), { supabase: supa, appUrl: 'https://app.test' })).toBe(false)
    }
    expect(postMessage).not.toHaveBeenCalled()
    // The window carries the running total, not a per-run reset.
    const stored = JSON.parse(kv.store.get('strand-branch-skew:window')!)
    expect(stored.counts.unresolved).toBe(40)
  })

  it('alerts once the window reaches the sample and one branch has gone dead', async () => {
    const kv = fakeKv()
    const alerted = await recordAndCheckBranchSkew(kv, counts({ unresolved: SKEW_MIN_SAMPLE }), { supabase: supa, appUrl: 'https://app.test' })
    expect(alerted).toBe(true)
    expect(postMessage).toHaveBeenCalledTimes(1)
    // The window resets after evaluating, so the next stretch is judged fresh.
    const stored = JSON.parse(kv.store.get('strand-branch-skew:window')!)
    expect(stored.counts.unresolved).toBe(0)
  })

  it('resets without alerting when the sample is reached but every branch fired', async () => {
    const kv = fakeKv()
    const healthy = counts({ unresolved: 40, graph_dead_end: 5, failed_step: 3, sighting_outcome: 5 })
    expect(await recordAndCheckBranchSkew(kv, healthy, { supabase: supa, appUrl: 'https://app.test' })).toBe(false)
    expect(postMessage).not.toHaveBeenCalled()
    expect(JSON.parse(kv.store.get('strand-branch-skew:window')!).counts.unresolved).toBe(0)
  })

  it('suppresses a repeat while the monthly cooldown is set', async () => {
    const kv = fakeKv({ 'strand-branch-skew-cooldown': '1' })
    expect(await recordAndCheckBranchSkew(kv, counts({ unresolved: SKEW_MIN_SAMPLE }), { supabase: supa, appUrl: 'https://app.test' })).toBe(false)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('touches no KV on a tick with no resolved rows (does not write ~1,440 times a day)', async () => {
    const kv = fakeKv()
    expect(await recordAndCheckBranchSkew(kv, emptyBranchCounts(), { supabase: supa, appUrl: 'https://app.test' })).toBe(false)
    expect(kv.get).not.toHaveBeenCalled()
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('resets the window once it has been judged, even when delivery fails, and re-detects on the next window', async () => {
    // Skewed but Slack delivery fails (returns null). The window still resets, so
    // it cannot grow without bound; the dead branch is persistent, so a fresh
    // window of the same shape re-detects it next time.
    vi.mocked(postMessage).mockResolvedValue(null as never)
    const kv = fakeKv()
    await recordAndCheckBranchSkew(kv, counts({ unresolved: SKEW_MIN_SAMPLE }), { supabase: supa, appUrl: 'https://app.test' })
    expect(JSON.parse(kv.store.get('strand-branch-skew:window')!).counts.unresolved).toBe(0)
    // Next window of the same shape detects it again (no cooldown was set, since
    // nothing delivered), so a failed delivery is not a permanently lost signal.
    vi.mocked(postMessage).mockResolvedValue('ts-2')
    expect(await recordAndCheckBranchSkew(kv, counts({ unresolved: SKEW_MIN_SAMPLE }), { supabase: supa, appUrl: 'https://app.test' })).toBe(true)
  })

  it('ages out a window that has sat below the sample for too long', async () => {
    const old = new Date(Date.parse('2026-01-01T00:00:00Z')).toISOString()
    const kv = fakeKv({ 'strand-branch-skew:window': JSON.stringify({ since: old, counts: counts({ unresolved: 40 }) }) })
    // A small addition, far in the future: still below sample, but the window is stale.
    await recordAndCheckBranchSkew(kv, counts({ unresolved: 1 }), { supabase: supa, appUrl: 'https://app.test', nowMs: Date.parse('2026-06-01T00:00:00Z') })
    const stored = JSON.parse(kv.store.get('strand-branch-skew:window')!)
    // The stale 40 is discarded, but THIS tick's row is kept, not thrown away.
    expect(stored.counts.unresolved).toBe(1)
  })
})
