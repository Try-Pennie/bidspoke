import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decideKillRateDrift, DRIFT_MARGIN_WEEKS, DRIFT_WINDOW_WEEKS, runKillRateDriftCheck } from '../kill-rate-drift'
import { countWeeklyKills } from '../../lib/job-run-record'
import { KILLS_IN_WEEK_THAT_SPEAK } from '../kill-rate'

vi.mock('../../lib/slack', () => ({
  getSlackConnection: vi.fn(),
  postMessage: vi.fn().mockResolvedValue('ts-1'),
}))
import { getSlackConnection, postMessage } from '../../lib/slack'

const DAY = 24 * 60 * 60 * 1000
const WEEK = 7 * DAY
const NOW = Date.parse('2026-10-11T12:00:00.000Z')

// A Supabase double: job_runs serves the seeded kill rows through the full chain
// countWeeklyKills uses, and service_connections serves the Slack org ids.
function supaWith(killStartedAt: string[], orgs: string[] = ['org-1']) {
  return {
    from: (table: string) => {
      if (table === 'job_runs') {
        const chain: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'is', 'gte', 'lt', 'order']) chain[m] = () => chain
        chain.limit = () => Promise.resolve({ data: killStartedAt.map((s) => ({ started_at: s })), error: null })
        return chain
      }
      if (table === 'service_connections') {
        return { select: () => ({ eq: () => Promise.resolve({ data: orgs.map((o) => ({ organization_id: o })), error: null }) }) }
      }
      throw new Error(`unexpected table ${table}`)
    },
  } as never
}

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  }
}

const slackOn = { bot_token: 't', default_channel: '#alerts', config_alerts_enabled: true }

// The thresholds were calibrated once (kill-rate.ts, 2026-09-15): ordinary weeks
// carried 2 to 4 kills and the 7/week threshold sat clear of them. This check
// re-measures the live weekly distribution and says when that premise no longer
// holds, so the constant stops being a dated sentence that expires in silence.
describe('decideKillRateDrift (#1355)', () => {
  it('stays quiet while ordinary weeks sit clear of the threshold, as calibrated', () => {
    // The calibrated shape: ordinary weeks at 2 to 4, threshold 7.
    const weeks = [2, 4, 3, 2, 4, 3, 0, 0]
    const v = decideKillRateDrift(weeks, KILLS_IN_WEEK_THAT_SPEAK)
    expect(v.drifted).toBe(false)
    expect(v.reason).toBeNull()
  })

  it('stays quiet on a brand-new or quiet archive, where the reader zero-fills every week', () => {
    // No data (or a table that has not existed long): all zeros must never drift.
    expect(decideKillRateDrift(Array(DRIFT_WINDOW_WEEKS).fill(0), KILLS_IN_WEEK_THAT_SPEAK).drifted).toBe(false)
  })

  it('does not drift on a single elevated week among otherwise ordinary weeks', () => {
    // One week near the threshold is a blip, not a sustained shift. The margin
    // verdict needs DRIFT_MARGIN_WEEKS of them.
    const weeks = [6, 3, 4, 2, 3, 0, 0, 0]
    expect(DRIFT_MARGIN_WEEKS).toBeGreaterThan(1)
    expect(decideKillRateDrift(weeks, KILLS_IN_WEEK_THAT_SPEAK).drifted).toBe(false)
  })

  it('does not count a week that itself tripped the threshold toward the margin verdict', () => {
    // A real cluster week (>= threshold) is the alert doing its job. One such week
    // plus one near-threshold ordinary week is not DRIFT_MARGIN_WEEKS ordinary ones.
    const weeks = [KILLS_IN_WEEK_THAT_SPEAK + 5, 6, 3, 2, 0, 0, 0, 0]
    expect(decideKillRateDrift(weeks, KILLS_IN_WEEK_THAT_SPEAK).drifted).toBe(false)
  })

  it('flags drift when several ordinary weeks have crept to within one of the threshold', () => {
    // The normal ceiling has risen to 5 to 6 across multiple weeks: a sustained
    // shift that has closed the margin, not one bad week.
    const weeks = [5, 6, 6, 5, 3, 2, 0, 0]
    const v = decideKillRateDrift(weeks, KILLS_IN_WEEK_THAT_SPEAK)
    expect(v.drifted).toBe(true)
    expect(v.reason).toMatch(/re-measure|recalibrat|no longer|crept/i)
  })

  it('flags drift when every recent week reaches the threshold, so it is no longer rare', () => {
    const weeks = Array(DRIFT_WINDOW_WEEKS).fill(KILLS_IN_WEEK_THAT_SPEAK)
    expect(decideKillRateDrift(weeks, KILLS_IN_WEEK_THAT_SPEAK).drifted).toBe(true)
  })
})

describe('countWeeklyKills (#1355)', () => {
  it('buckets kills into rolling 7-day weeks, newest week first', async () => {
    // One kill two days ago (week 0), two kills nine and ten days ago (week 1),
    // one kill well outside the window (ignored).
    const started = [
      new Date(NOW - 2 * DAY).toISOString(),
      new Date(NOW - 9 * DAY).toISOString(),
      new Date(NOW - 10 * DAY).toISOString(),
      new Date(NOW - 100 * DAY).toISOString(),
    ]
    const res = await countWeeklyKills(supaWith(started), 'execution-archive', NOW, DRIFT_WINDOW_WEEKS)
    expect(res.kind).toBe('counted')
    if (res.kind !== 'counted') return
    expect(res.weeks[0]).toBe(1)
    expect(res.weeks[1]).toBe(2)
    expect(res.weeks.reduce((a, b) => a + b, 0)).toBe(3)
  })
})

describe('runKillRateDriftCheck (#1355)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSlackConnection).mockResolvedValue(slackOn as never)
    vi.mocked(postMessage).mockResolvedValue('ts-1')
  })

  // Six kills in each of several rolling weeks: ordinary weeks reach 6, within one
  // of the 7 threshold, so the calibration margin is gone.
  const driftedStartedAt = (): string[] => {
    const out: string[] = []
    for (let w = 0; w < 6; w++) for (let k = 0; k < 6; k++) out.push(new Date(NOW - w * WEEK - (k + 1) * DAY * 0.1 - DAY).toISOString())
    return out
  }

  it('stays silent when the weekly distribution still sits where it was calibrated', async () => {
    const started: string[] = []
    for (let w = 0; w < 6; w++) for (let k = 0; k < 3; k++) out(started, NOW - w * WEEK - DAY * (k + 1))
    expect(await runKillRateDriftCheck(supaWith(started), fakeKv(), 'https://app.test', NOW)).toBe(false)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('alerts when the ordinary weekly rate has drifted up to the threshold margin', async () => {
    expect(await runKillRateDriftCheck(supaWith(driftedStartedAt()), fakeKv(), 'https://app.test', NOW)).toBe(true)
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(vi.mocked(postMessage).mock.calls[0][2])).toMatch(/re-measur/i)
  })

  it('suppresses a repeat while the monthly cooldown is set', async () => {
    const kv = fakeKv({ 'killrate-drift-cooldown': '1' })
    expect(await runKillRateDriftCheck(supaWith(driftedStartedAt()), kv, 'https://app.test', NOW)).toBe(false)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('alerts on a full-page read, which is extreme drift, rather than staying silent', async () => {
    // 250 unfinished runs exceeds the read limit, so the reader returns a floor. A
    // read error would be skipped, but a floor is itself far above the calibrated rate.
    const many = Array.from({ length: 250 }, (_unused, i) => new Date(NOW - i * 0.02 * DAY - DAY).toISOString())
    expect(await runKillRateDriftCheck(supaWith(many), fakeKv(), 'https://app.test', NOW)).toBe(true)
    expect(JSON.stringify(vi.mocked(postMessage).mock.calls[0][2])).toMatch(/at scale|far above|unfinished/i)
  })

  it('stays silent on a read error, which is reported elsewhere', async () => {
    const supaErr = {
      from: (table: string) => {
        if (table === 'job_runs') {
          const chain: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'is', 'gte', 'lt', 'order']) chain[m] = () => chain
          chain.limit = () => Promise.resolve({ data: null, error: { message: 'connection refused' } })
          return chain
        }
        return { select: () => ({ eq: () => Promise.resolve({ data: [{ organization_id: 'org-1' }], error: null }) }) }
      },
    } as never
    expect(await runKillRateDriftCheck(supaErr, fakeKv(), 'https://app.test', NOW)).toBe(false)
    expect(postMessage).not.toHaveBeenCalled()
  })
})

function out(arr: string[], ms: number): void {
  arr.push(new Date(ms).toISOString())
}
