/**
 * The strand-drain branch-skew check (#1133): catch the conservative unresolved
 * fallback resolving every row over a meaningful sample while no precise branch
 * ever fires, which is the shape of a precise path that cannot match (L551). A
 * single precise branch legitimately absent is not flagged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decideBranchSkew, recordAndCheckBranchSkew, SKEW_MIN_SAMPLE } from '../strand-branch-skew'
import { emptyBranchCounts, type StrandBranch } from '../stranded-executions'

vi.mock('../slack', () => ({
  getSlackConnection: vi.fn(),
  postMessage: vi.fn().mockResolvedValue('ts-1'),
}))
import { getSlackConnection, postMessage } from '../slack'
import { alertRowListAnswer } from '../../__tests__/helpers/slack-alert-read'

const counts = (over: Partial<Record<StrandBranch, number>>): Record<StrandBranch, number> => ({ ...emptyBranchCounts(), ...over })

describe('decideBranchSkew (#1133)', () => {
  it('stays quiet below the minimum sample, however lopsided', () => {
    expect(decideBranchSkew(counts({ unresolved: 10 })).skewed).toBe(false)
  })

  it('flags the fallback resolving everything while no precise branch fired (the #1112 shape)', () => {
    const v = decideBranchSkew(counts({ unresolved: 119 }))
    expect(v.skewed).toBe(true)
    // Admin-facing, plain language: no internal branch ids, lesson or issue refs.
    expect(v.reason).toMatch(/precise check/i)
    expect(v.reason).toMatch(/all 119/)
    expect(v.reason).not.toMatch(/L551|#1112|#1133|graph_dead_end|unresolved/)
  })

  it('stays quiet when a precise branch has fired at least once (the precise path demonstrably works)', () => {
    // 118 unresolved and a single graph_dead_end: the precise path CAN fire, so
    // whatever is rare is rare, not dead.
    expect(decideBranchSkew(counts({ unresolved: 118, graph_dead_end: 1 })).skewed).toBe(false)
  })

  it('does not flag a legitimately rare precise branch that happens to be absent, when another precise branch fired', () => {
    // graph_dead_end at zero (normal for a code-node-answering workflow), but
    // sighting_outcome and failed_step fired: not a dead branch, no alert.
    expect(decideBranchSkew(counts({ unresolved: 40, sighting_outcome: 7, failed_step: 3 })).skewed).toBe(false)
  })

  it('does not flag a precise branch dominating (failed_step taking effectively everything is not a hidden fallback)', () => {
    // The #1133 review case: a healthy drain where almost every row genuinely
    // failed. failed_step is precise, so this is not the fallback-hiding shape.
    expect(decideBranchSkew(counts({ failed_step: 50 })).skewed).toBe(false)
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
  from: () => ({ select: () => alertRowListAnswer({ data: [{ organization_id: 'org-1' }], error: null }) }),
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

  it('resets the window after judging it even when delivery fails, and re-detects on the next full window', async () => {
    // Slack delivery fails (returns null): the window still resets, so it can never
    // grow or re-run the fan-out every tick. The dead branch is persistent, so a
    // fresh window of the same shape re-detects and (now) delivers.
    vi.mocked(postMessage).mockResolvedValue(null as never)
    const kv = fakeKv()
    expect(await recordAndCheckBranchSkew(kv, counts({ unresolved: SKEW_MIN_SAMPLE }), { supabase: supa, appUrl: 'https://app.test' })).toBe(false)
    expect(JSON.parse(kv.store.get('strand-branch-skew:window')!).counts.unresolved).toBe(0)
    vi.mocked(postMessage).mockResolvedValue('ts-2')
    expect(await recordAndCheckBranchSkew(kv, counts({ unresolved: SKEW_MIN_SAMPLE }), { supabase: supa, appUrl: 'https://app.test' })).toBe(true)
  })

  it('resets the window before alerting, so a throw during the alert cannot leave a stale over-sample window', async () => {
    // The cooldown read inside rateLimitedOrgAlert throws. The window was already
    // reset before the alert, so no stale over-sample window is left behind to
    // re-fire every tick; the throw propagates to the caller's waitUntil catch.
    const store = new Map<string, string>()
    const kv = {
      get: vi.fn(async (k: string) => {
        if (k === 'strand-branch-skew-cooldown') throw new Error('kv down')
        return store.get(k) ?? null
      }),
      put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    }
    await expect(recordAndCheckBranchSkew(kv, counts({ unresolved: SKEW_MIN_SAMPLE }), { supabase: supa, appUrl: 'https://app.test' })).rejects.toThrow()
    expect(JSON.parse(store.get('strand-branch-skew:window')!).counts.unresolved).toBe(0)
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
