/**
 * The bid recording silence detector (#1157).
 *
 * Lead Economy wrote sightings for weeks and never one row to
 * lead_sighting_bids, and nothing reported it: the runs succeeded, so the
 * failure surfaces only as data that does not exist. This judges each workflow
 * against ITS PEERS in the same window, which is what makes the accusation safe.
 *
 * The peer comparison is not decoration. Measured on prod 2026-09-04, bid rows
 * are purged about 25 hours back while their sightings survive: the 16:00 and
 * 17:00 hours of the previous day held 2,315 and 6,382 sightings and ZERO bid
 * rows, with the ratio normal from 19:00 onward. So "no bid rows" is a true
 * statement about a drained window as often as about a broken workflow, and the
 * only thing that separates them is whether anything else recorded.
 */
import { describe, it, expect } from 'vitest'
import { decideBidRecordingAlert, type BidCoverageRow } from '../bid-recording-coverage'

const opts = { minSightings: 50 }

function row(over: Partial<BidCoverageRow> & { workflow_name: string }): BidCoverageRow {
  return {
    workflow_id: `wf-${over.workflow_name}`,
    is_active: true,
    sightings: 1000,
    bid_rows: 500,
    winners: 100,
    ...over,
  }
}

describe('decideBidRecordingAlert', () => {
  it('names a workflow that recorded no bids while its peers did', () => {
    const d = decideBidRecordingAlert([
      row({ workflow_name: 'Engine', sightings: 79165, bid_rows: 44662, winners: 2480 }),
      row({ workflow_name: 'Lead Economy', sightings: 6814, bid_rows: 0, winners: 0 }),
    ], opts)
    expect(d.alert).toBe(true)
    expect(d.reason).toBe('silent_workflows')
    expect(d.silent).toEqual([
      { workflow_id: 'wf-Lead Economy', workflow_name: 'Lead Economy', is_active: true, sightings: 6814, winners: 0 },
    ])
  })

  it('stays quiet when every workflow recorded bids', () => {
    const d = decideBidRecordingAlert([
      row({ workflow_name: 'Engine' }),
      row({ workflow_name: 'Main Flow', sightings: 4045, bid_rows: 1414, winners: 1076 }),
    ], opts)
    expect(d).toMatchObject({ alert: false, reason: 'recording', silent: [] })
  })

  it('refuses to accuse anyone when NOTHING recorded a bid in the window', () => {
    // The signature of a purged window, and of a total engine outage. Both are
    // real, neither is "this workflow is broken", and the data cannot tell them
    // apart, so the detector must report the window rather than name a workflow
    // (LESSONS L11: a message may claim only what its check measured).
    const d = decideBidRecordingAlert([
      row({ workflow_name: 'Engine', sightings: 6382, bid_rows: 0, winners: 0 }),
      row({ workflow_name: 'Lead Economy', sightings: 2315, bid_rows: 0, winners: 0 }),
    ], opts)
    expect(d.alert).toBe(false)
    expect(d.reason).toBe('window_not_retained')
    expect(d.silent).toEqual([])
  })

  it('does not judge a workflow below the sightings floor', () => {
    const d = decideBidRecordingAlert([
      row({ workflow_name: 'Engine' }),
      row({ workflow_name: 'Trickle', sightings: 49, bid_rows: 0, winners: 0 }),
    ], opts)
    expect(d).toMatchObject({ alert: false, reason: 'recording' })
    expect(d.unjudged).toEqual(['Trickle'])
  })

  it('judges a workflow exactly at the floor', () => {
    const d = decideBidRecordingAlert([
      row({ workflow_name: 'Engine' }),
      row({ workflow_name: 'Small', sightings: 50, bid_rows: 0, winners: 0 }),
    ], opts)
    expect(d.alert).toBe(true)
    expect(d.silent.map((s) => s.workflow_name)).toEqual(['Small'])
  })

  it('reports no sightings at all as its own outcome, not as health', () => {
    // Nothing to measure is not the same as measured and fine (LESSONS L98).
    const d = decideBidRecordingAlert([], opts)
    expect(d).toMatchObject({ alert: false, reason: 'no_sightings', silent: [] })
  })

  it('treats a window of rows that all carry zero sightings as no sightings', () => {
    const d = decideBidRecordingAlert([row({ workflow_name: 'Idle', sightings: 0, bid_rows: 0, winners: 0 })], opts)
    expect(d.reason).toBe('no_sightings')
  })

  it('sorts the silent workflows by volume, worst first', () => {
    const d = decideBidRecordingAlert([
      row({ workflow_name: 'Engine' }),
      row({ workflow_name: 'Quiet', sightings: 200, bid_rows: 0, winners: 0 }),
      row({ workflow_name: 'Busy', sightings: 9000, bid_rows: 0, winners: 0 }),
    ], opts)
    expect(d.silent.map((s) => s.workflow_name)).toEqual(['Busy', 'Quiet'])
  })

  it('still names an inactive workflow, marked as inactive', () => {
    // It ran and recorded nothing, which is a real gap in the data even though
    // nobody can act on the workflow itself, so the flag travels with the row
    // rather than deciding whether to report it.
    const d = decideBidRecordingAlert([
      row({ workflow_name: 'Engine' }),
      row({ workflow_name: 'Retired', sightings: 900, bid_rows: 0, winners: 0, is_active: false }),
    ], opts)
    expect(d.silent).toEqual([
      { workflow_id: 'wf-Retired', workflow_name: 'Retired', is_active: false, sightings: 900, winners: 0 },
    ])
  })

  describe('unusable rows', () => {
    it('reports a row whose counts are not usable numbers rather than judging it', () => {
      // A NaN compares false against every threshold and would land silently on
      // the healthy side (LESSONS L50).
      const d = decideBidRecordingAlert([
        row({ workflow_name: 'Engine' }),
        row({ workflow_name: 'Broken', sightings: Number.NaN, bid_rows: 0, winners: 0 }),
      ], opts)
      expect(d.unusable).toEqual(['Broken'])
      expect(d.silent).toEqual([])
      expect(d.reason).toBe('recording')
    })

    it('reports a negative count as unusable', () => {
      const d = decideBidRecordingAlert([
        row({ workflow_name: 'Engine' }),
        row({ workflow_name: 'Negative', sightings: 100, bid_rows: -1, winners: 0 }),
      ], opts)
      expect(d.unusable).toEqual(['Negative'])
    })

    it('reports more bids than are arithmetically possible as unusable', () => {
      // winners cannot exceed sightings: that is a bad aggregation in the
      // function, not a partner problem, and rendering it into an alert would
      // misdirect whoever reads it.
      const d = decideBidRecordingAlert([
        row({ workflow_name: 'Engine' }),
        row({ workflow_name: 'Impossible', sightings: 10, bid_rows: 5, winners: 11 }),
      ], opts)
      expect(d.unusable).toEqual(['Impossible'])
    })

    it('does not let an unusable row stand in for the peer that proves retention', () => {
      // If the only row with bid rows is unusable, nothing usable recorded a
      // bid, so the window is unproven and no accusation may be made.
      const d = decideBidRecordingAlert([
        row({ workflow_name: 'Broken', sightings: 100, bid_rows: Number.NaN, winners: 0 }),
        row({ workflow_name: 'Silent', sightings: 5000, bid_rows: 0, winners: 0 }),
      ], opts)
      expect(d.alert).toBe(false)
      expect(d.reason).toBe('window_not_retained')
      expect(d.unusable).toEqual(['Broken'])
    })
  })
})

// ── The scheduled orchestration ──────────────────────────────────────────────
//
// The pure decision above says nothing about whether anybody is actually told.
// These cover the paths that decide that: which organizations are checked, what
// the cooldown suppresses, and what happens when the query or Slack fails. Same
// shape as the email-drop-rate suite, deliberately, so the two checks are read
// the same way.

import { vi, beforeEach, afterEach } from 'vitest'

const postMessage = vi.hoisted(() => vi.fn())
const getSlackConnection = vi.hoisted(() => vi.fn())

vi.mock('../slack', () => ({ postMessage, getSlackConnection }))

const { runBidRecordingCoverageCheck, WINDOW_HOURS } = await import('../bid-recording-coverage')

function makeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
  }
}

function makeSupabase(opts: {
  orgs?: string[]
  orgsError?: string
  rpc?: (orgId: string) => { data: unknown; error: { message: string } | null }
}) {
  const rpcCalls: Array<{ org: string; since: string }> = []
  const client = {
    from: () => ({
      select: () => ({
        eq: async () => ({
          data: opts.orgsError ? null : (opts.orgs ?? ['org-1']).map((organization_id) => ({ organization_id })),
          error: opts.orgsError ? { message: opts.orgsError } : null,
        }),
      }),
    }),
    rpc: vi.fn(async (_fn: string, args: { p_org_id: string; p_since: string }) => {
      rpcCalls.push({ org: args.p_org_id, since: args.p_since })
      return opts.rpc ? opts.rpc(args.p_org_id) : { data: [], error: null }
    }),
  }
  return { client: client as never, rpcCalls }
}

/** One workflow recording normally (which proves the window) and one silent. */
const SILENT = [
  { workflow_id: 'wf-engine', workflow_name: 'Engine', is_active: true, sightings: 9000, bid_rows: 5000, winners: 300 },
  { workflow_id: 'wf-le', workflow_name: 'Lead Economy', is_active: true, sightings: 1700, bid_rows: 0, winners: 0 },
]
const HEALTHY = [SILENT[0]]
const DRAINED = [
  { workflow_id: 'wf-engine', workflow_name: 'Engine', is_active: true, sightings: 9000, bid_rows: 0, winners: 0 },
]

beforeEach(() => {
  vi.clearAllMocks()
  getSlackConnection.mockResolvedValue({ bot_token: 't', default_channel: '#c', volume_alerts_enabled: true })
  postMessage.mockResolvedValue('ts-1')
})
afterEach(() => { vi.restoreAllMocks() })

/**
 * Keys written by the ALERT cooldown, ignoring the ratio baseline (#1168).
 *
 * These assertions are about whether a cooldown was set, and the same KV now
 * carries the per-workflow ratio history, which is written on every run by
 * design. Asserting on "put was never called" would fail on that unrelated
 * write, so the question is asked precisely instead of broadly.
 */
function cooldownPuts(kv: ReturnType<typeof makeKv>): string[] {
  return kv.put.mock.calls.map((c) => c[0] as string).filter((k) => !k.startsWith('bid-ratio-history:'))
}

describe('runBidRecordingCoverageCheck: who gets told (#1157)', () => {
  it('posts once, naming the workflow and its lead volume', async () => {
    const kv = makeKv()
    const db = makeSupabase({ rpc: () => ({ data: SILENT, error: null }) })
    await runBidRecordingCoverageCheck(db.client, kv)
    expect(postMessage).toHaveBeenCalledTimes(1)
    const body = JSON.stringify(postMessage.mock.calls[0])
    expect(body).toContain('Lead Economy')
    expect(body).toContain('1700')
    expect(body).not.toContain('Engine')
  })

  it('says nothing when every workflow is recording', async () => {
    const kv = makeKv()
    const db = makeSupabase({ rpc: () => ({ data: HEALTHY, error: null }) })
    await runBidRecordingCoverageCheck(db.client, kv)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('accuses nobody when the whole window recorded nothing', async () => {
    const kv = makeKv()
    const db = makeSupabase({ rpc: () => ({ data: DRAINED, error: null }) })
    await runBidRecordingCoverageCheck(db.client, kv)
    expect(postMessage).not.toHaveBeenCalled()
    expect(getSlackConnection).not.toHaveBeenCalled()
  })

  it('asks only for the window it judges', async () => {
    const kv = makeKv()
    const db = makeSupabase({ rpc: () => ({ data: HEALTHY, error: null }) })
    await runBidRecordingCoverageCheck(db.client, kv)
    const ageHours = (Date.now() - Date.parse(db.rpcCalls[0].since)) / 3_600_000
    expect(ageHours).toBeCloseTo(WINDOW_HOURS, 1)
  })

  it('checks every organization with Slack connected', async () => {
    const kv = makeKv()
    const db = makeSupabase({ orgs: ['org-1', 'org-2'], rpc: () => ({ data: HEALTHY, error: null }) })
    await runBidRecordingCoverageCheck(db.client, kv)
    expect(db.rpcCalls.map((c) => c.org)).toEqual(['org-1', 'org-2'])
  })

  it('does not repeat the same workflow within the cooldown', async () => {
    const kv = makeKv()
    const db = makeSupabase({ rpc: () => ({ data: SILENT, error: null }) })
    await runBidRecordingCoverageCheck(db.client, kv)
    await runBidRecordingCoverageCheck(db.client, kv)
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('stays silent when volume alerts are switched off', async () => {
    getSlackConnection.mockResolvedValue({ bot_token: 't', default_channel: '#c', volume_alerts_enabled: false })
    const kv = makeKv()
    const db = makeSupabase({ rpc: () => ({ data: SILENT, error: null }) })
    await runBidRecordingCoverageCheck(db.client, kv)
    expect(postMessage).not.toHaveBeenCalled()
  })
})

describe('runBidRecordingCoverageCheck: failure paths (#1157)', () => {
  it('does not throw, and tells nobody, when the organization lookup fails', async () => {
    const kv = makeKv()
    const db = makeSupabase({ orgsError: 'connection reset' })
    await expect(runBidRecordingCoverageCheck(db.client, kv)).resolves.toBeUndefined()
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('does not accuse a workflow when the coverage query itself failed', async () => {
    // A failed read is not an empty window. Alerting here would name whichever
    // workflow happened to be missing from a result that was never returned.
    const kv = makeKv()
    const db = makeSupabase({ rpc: () => ({ data: null, error: { message: 'statement timeout' } }) })
    await runBidRecordingCoverageCheck(db.client, kv)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('carries on to the next organization when one throws', async () => {
    const kv = makeKv()
    const db = makeSupabase({
      orgs: ['org-bad', 'org-good'],
      rpc: (org) => {
        if (org === 'org-bad') throw new Error('boom')
        return { data: SILENT, error: null }
      },
    })
    await runBidRecordingCoverageCheck(db.client, kv)
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(postMessage.mock.calls[0])).toContain('Lead Economy')
  })

  it('leaves the cooldown unset when Slack did not accept the message', async () => {
    // Setting it optimistically would swallow the single notification whenever
    // Slack was briefly unavailable, then stay quiet for a day.
    postMessage.mockResolvedValue(null)
    const kv = makeKv()
    const db = makeSupabase({ rpc: () => ({ data: SILENT, error: null }) })
    await runBidRecordingCoverageCheck(db.client, kv)
    expect(cooldownPuts(kv)).toEqual([])
    await runBidRecordingCoverageCheck(db.client, kv)
    expect(postMessage).toHaveBeenCalledTimes(2)
  })

  it('leaves the cooldown unset when the send throws', async () => {
    postMessage.mockRejectedValue(new Error('slack down'))
    const kv = makeKv()
    const db = makeSupabase({ rpc: () => ({ data: SILENT, error: null }) })
    await expect(runBidRecordingCoverageCheck(db.client, kv)).resolves.toBeUndefined()
    expect(cooldownPuts(kv)).toEqual([])
  })
})

/**
 * The ratio collapse check, driven through the real scheduled entry point (#1168).
 *
 * The pure decision is tested in bid-ratio-collapse.test.ts. What these assert is
 * that it is actually REACHED and that its history survives between runs, which
 * is the failure mode a detector like this really has: a module nothing calls
 * and a baseline that never accumulates both look exactly like a quiet system.
 */
import { MIN_BASELINE_SAMPLES } from '../bid-ratio-collapse'

/** Engine proving the window, plus a workflow whose ratio has halved. */
const HALVED = [
  { workflow_id: 'wf-engine', workflow_name: 'Engine', is_active: true, sightings: 9000, bid_rows: 5000, winners: 300 },
  { workflow_id: 'wf-le', workflow_name: 'Lead Economy', is_active: true, sightings: 1000, bid_rows: 60, winners: 20 },
]
/** The same two, both recording normally. */
const BOTH_NORMAL = [
  HALVED[0],
  { workflow_id: 'wf-le', workflow_name: 'Lead Economy', is_active: true, sightings: 1000, bid_rows: 600, winners: 200 },
]

/** Run the check `n` times on a healthy fixture so a baseline accumulates. */
async function buildBaseline(kv: ReturnType<typeof makeKv>, n: number) {
  for (let i = 0; i < n; i++) {
    const db = makeSupabase({ rpc: () => ({ data: BOTH_NORMAL, error: null }) })
    await runBidRecordingCoverageCheck(db.client, kv)
  }
}

describe('ratio collapse: reached from the scheduled check (#1168)', () => {
  it('says nothing on the first run, because there is no baseline yet', async () => {
    const kv = makeKv()
    const db = makeSupabase({ rpc: () => ({ data: HALVED, error: null }) })
    await runBidRecordingCoverageCheck(db.client, kv)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('records a reading on that first run, so a baseline can accumulate', async () => {
    const kv = makeKv()
    const db = makeSupabase({ rpc: () => ({ data: BOTH_NORMAL, error: null }) })
    await runBidRecordingCoverageCheck(db.client, kv)
    const stored = JSON.parse(kv.store.get('bid-ratio-history:org-1')!)
    expect(stored['wf-le'].ratios).toEqual([0.6])
  })

  it('alerts once a workflow with a baseline halves its ratio', async () => {
    const kv = makeKv()
    await buildBaseline(kv, MIN_BASELINE_SAMPLES)
    postMessage.mockClear()

    const db = makeSupabase({ rpc: () => ({ data: HALVED, error: null }) })
    await runBidRecordingCoverageCheck(db.client, kv)

    expect(postMessage).toHaveBeenCalledTimes(1)
    const [, , blocks] = postMessage.mock.calls[0]
    const text = JSON.stringify(blocks)
    expect(text).toContain('Lead Economy')
    expect(text).toContain('far fewer bids than usual')
    // The numbers a person needs to act, not just a percentage.
    expect(text).toContain('60 bids across 1000 leads')
  })

  it('stays quiet when a workflow with a baseline is recording normally', async () => {
    const kv = makeKv()
    await buildBaseline(kv, MIN_BASELINE_SAMPLES)
    postMessage.mockClear()

    const db = makeSupabase({ rpc: () => ({ data: BOTH_NORMAL, error: null }) })
    await runBidRecordingCoverageCheck(db.client, kv)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('does not repeat the alert while the fault persists', async () => {
    const kv = makeKv()
    await buildBaseline(kv, MIN_BASELINE_SAMPLES)
    postMessage.mockClear()

    for (let i = 0; i < 3; i++) {
      const db = makeSupabase({ rpc: () => ({ data: HALVED, error: null }) })
      await runBidRecordingCoverageCheck(db.client, kv)
    }
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('does not let a sustained fault become the new baseline', async () => {
    // If a collapsed reading were stored, the median would walk down until the
    // broken rate read as healthy and the alarm switched itself off.
    const kv = makeKv()
    await buildBaseline(kv, MIN_BASELINE_SAMPLES)
    for (let i = 0; i < MIN_BASELINE_SAMPLES; i++) {
      const db = makeSupabase({ rpc: () => ({ data: HALVED, error: null }) })
      await runBidRecordingCoverageCheck(db.client, kv)
    }
    const stored = JSON.parse(kv.store.get('bid-ratio-history:org-1')!)
    expect(stored['wf-le'].ratios.every((r: number) => r === 0.6)).toBe(true)
  })

  it('does not alert when the window was never proven retained', async () => {
    // A drained window understates every workflow at once, so judging ratios
    // there would accuse all of them.
    const kv = makeKv()
    await buildBaseline(kv, MIN_BASELINE_SAMPLES)
    postMessage.mockClear()

    const db = makeSupabase({ rpc: () => ({ data: DRAINED, error: null }) })
    await runBidRecordingCoverageCheck(db.client, kv)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('survives a corrupt history rather than taking the check down', async () => {
    const kv = makeKv()
    kv.store.set('bid-ratio-history:org-1', 'not json')
    const db = makeSupabase({ rpc: () => ({ data: BOTH_NORMAL, error: null }) })
    await expect(runBidRecordingCoverageCheck(db.client, kv)).resolves.toBeUndefined()
    // And it rebuilds from this run rather than staying broken.
    const stored = JSON.parse(kv.store.get('bid-ratio-history:org-1')!)
    expect(stored['wf-le'].ratios).toEqual([0.6])
  })

  it('keeps each organization history separate', async () => {
    const kv = makeKv()
    const db = makeSupabase({ orgs: ['org-1', 'org-2'], rpc: () => ({ data: BOTH_NORMAL, error: null }) })
    await runBidRecordingCoverageCheck(db.client, kv)
    expect(kv.store.has('bid-ratio-history:org-1')).toBe(true)
    expect(kv.store.has('bid-ratio-history:org-2')).toBe(true)
  })
})

/**
 * Two faults the lessons scan caught in the ratio check, both worth a test.
 *
 * The ratio check must never be able to take down the total-silence check it
 * runs beside (L73). They answer different questions and one failing is not a
 * reason to lose the other, but they now share a handler and the ratio half
 * touches KV, which the silence half does not.
 *
 * And a stored history is parsed from KV, so a value that is not a number must
 * not reach the comparison (L50). NaN compares false against every threshold, so
 * a poisoned history would leave the detector reading as working and unable to
 * fire, which is the exact failure this whole design was shaped to avoid.
 */
describe('ratio check failure isolation (#1168)', () => {
  it('a KV failure in the ratio check does not suppress the silent workflow alert', async () => {
    const kv = makeKv()
    // Only the ratio check's OWN key fails. Failing every read would also break
    // the alert cooldown lookup, which is a separate pre-existing path and not
    // what this asserts.
    kv.get.mockImplementation(async (k: string) => {
      if (k.startsWith('bid-ratio-history:')) throw new Error('KV down')
      return kv.store.get(k) ?? null
    })
    const db = makeSupabase({ rpc: () => ({ data: SILENT, error: null }) })

    await expect(runBidRecordingCoverageCheck(db.client, kv)).resolves.toBeUndefined()

    // The #1157 alert still goes out: the two checks answer different questions.
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(postMessage.mock.calls[0][2])).toContain('recording no bids')
  })

  it('a KV write failure does not suppress the silent workflow alert either', async () => {
    const kv = makeKv()
    kv.put.mockRejectedValue(new Error('KV write down'))
    const db = makeSupabase({ rpc: () => ({ data: SILENT, error: null }) })
    await expect(runBidRecordingCoverageCheck(db.client, kv)).resolves.toBeUndefined()
    expect(postMessage).toHaveBeenCalled()
  })
})

describe('ratio history that is not numbers (#1168)', () => {
  it('refuses a history whose readings are not numbers rather than comparing against NaN', async () => {
    const kv = makeKv()
    kv.store.set(
      'bid-ratio-history:org-1',
      JSON.stringify({ 'wf-le': { ratios: Array.from({ length: MIN_BASELINE_SAMPLES }, () => 'oops') } }),
    )
    const db = makeSupabase({ rpc: () => ({ data: HALVED, error: null }) })
    await runBidRecordingCoverageCheck(db.client, kv)
    // Not judged, and specifically not judged as healthy.
    expect(postMessage).not.toHaveBeenCalled()
    // And the poisoned entry is replaced by a real reading.
    const stored = JSON.parse(kv.store.get('bid-ratio-history:org-1')!)
    expect(stored['wf-le'].ratios).toEqual([0.06])
  })

  it('ignores a stray non-number among otherwise good readings', async () => {
    const ratios: unknown[] = Array.from({ length: MIN_BASELINE_SAMPLES }, () => 0.6)
    ratios[2] = null
    const kv = makeKv()
    kv.store.set('bid-ratio-history:org-1', JSON.stringify({ 'wf-le': { ratios } }))
    const db = makeSupabase({ rpc: () => ({ data: HALVED, error: null }) })
    await runBidRecordingCoverageCheck(db.client, kv)
    // One bad entry leaves too few readings to judge, so it stays quiet rather
    // than judging against a shorter history than the design requires.
    expect(postMessage).not.toHaveBeenCalled()
  })
})
