/**
 * Issue #744. When Salesforce rejects a lead's email, the node blanks the field
 * and retries, so the run SUCCEEDS. That is the right outcome for the lead (a
 * cosmetically broken address must not cost us someone we can still phone), but
 * it means no Slack alert and no dashboard signal: the only trace is a warning
 * inside that one execution's detail, on a short retention window.
 *
 * So making the failure self-recovering also deleted the thing that counted it.
 * If a partner's form starts producing damaged addresses in bulk (an encoding
 * change would do it) the rate could go from one a week to hundreds a day with
 * nothing surfacing it, and every one of those leads reaches Salesforce with no
 * email address at all.
 *
 * This is the recorded pattern that an error deliberately classified as expected
 * still needs a RATE behind it (LESSONS L77): the code waving it through has no
 * notion of volume, so one benign instance and a systemic upstream problem arrive
 * on the same path and are indistinguishable.
 *
 * Two things the decision has to get right, both asserted below:
 *   - it must be a RATE per source, not a count, or it fires on the quietest
 *     source and stays silent on the busiest (LESSONS L117)
 *   - a source with almost no volume must not trip it, because 1 drop out of 2
 *     leads is 50% and means nothing
 */
import { describe, it, expect } from 'vitest'
import { decideEmailDropAlert, type SourceDropStats } from '../email-drop-rate'

const OPTS = { minVolume: 20, rateThreshold: 0.05 }

function rows(...r: Array<[string | null, number, number]>): SourceDropStats[] {
  return r.map(([source_name, total, dropped]) => ({ source_name, total, dropped }))
}

describe('decideEmailDropAlert: rate per source, not a raw count (#744)', () => {
  it('alerts on a source whose drop rate is above the threshold', () => {
    const d = decideEmailDropAlert(rows(['partner_a', 1000, 200]), OPTS)
    expect(d.alert).toBe(true)
    expect(d.offenders.map((o) => o.source)).toEqual(['partner_a'])
    expect(d.offenders[0].rate).toBeCloseTo(0.2)
  })

  it('stays quiet on a source below the threshold', () => {
    expect(decideEmailDropAlert(rows(['partner_a', 1000, 10]), OPTS).alert).toBe(false)
  })

  it('names every offending source, not just the worst', () => {
    const d = decideEmailDropAlert(
      rows(['partner_a', 500, 100], ['partner_b', 500, 4], ['partner_c', 400, 80]),
      OPTS,
    )
    expect(d.offenders.map((o) => o.source).sort()).toEqual(['partner_a', 'partner_c'])
  })

  it('orders offenders worst first, so the message leads with the biggest problem', () => {
    const d = decideEmailDropAlert(rows(['low', 1000, 60], ['high', 1000, 500]), OPTS)
    expect(d.offenders.map((o) => o.source)).toEqual(['high', 'low'])
  })

  it('judges each source on its own volume, so a busy clean source cannot mask a broken one', () => {
    // The pooling trap (LESSONS L117): a rate computed across all sources
    // together would be 100/100000, far under threshold, and the broken source
    // would never surface.
    const d = decideEmailDropAlert(rows(['huge_clean', 99000, 0], ['small_broken', 1000, 100]), OPTS)
    expect(d.alert).toBe(true)
    expect(d.offenders.map((o) => o.source)).toEqual(['small_broken'])
  })
})

describe('decideEmailDropAlert: low volume cannot trip it (#744)', () => {
  it('ignores a source below the minimum volume even at a 100 percent drop rate', () => {
    expect(decideEmailDropAlert(rows(['tiny', 2, 2]), OPTS).alert).toBe(false)
  })

  it('ignores a source exactly one lead below the minimum', () => {
    expect(decideEmailDropAlert(rows(['tiny', 19, 19]), OPTS).alert).toBe(false)
  })

  it('includes a source once it reaches the minimum volume', () => {
    expect(decideEmailDropAlert(rows(['ok', 20, 20]), OPTS).alert).toBe(true)
  })
})

describe('decideEmailDropAlert: finding nothing is not the same as healthy (#744)', () => {
  it('reports no_executions when the window held no leads at all', () => {
    // A query that broke, or a genuinely dead feed, both produce zero rows. That
    // must not read as "the drop rate is fine" (LESSONS L98), because a dead feed
    // is itself worth knowing about and a broken query makes this check useless
    // while looking healthy.
    const d = decideEmailDropAlert([], OPTS)
    expect(d.alert).toBe(false)
    expect(d.reason).toBe('no_executions')
  })

  it('reports no_executions when every source has zero total', () => {
    const d = decideEmailDropAlert(rows(['a', 0, 0], ['b', 0, 0]), OPTS)
    expect(d.reason).toBe('no_executions')
  })

  it('distinguishes a healthy window from an empty one', () => {
    const d = decideEmailDropAlert(rows(['a', 500, 1]), OPTS)
    expect(d.alert).toBe(false)
    expect(d.reason).toBe('within_threshold')
  })

  it('reports below_min_volume when there was traffic but none of it measurable', () => {
    const d = decideEmailDropAlert(rows(['a', 5, 5], ['b', 3, 0]), OPTS)
    expect(d.alert).toBe(false)
    expect(d.reason).toBe('below_min_volume')
  })
})

describe('decideEmailDropAlert: refuses to read a broken row as healthy (#744)', () => {
  it('ignores a row whose counts are not usable numbers', () => {
    // A value parsed out of a database response must not feed a comparison
    // directly (LESSONS L50): NaN compares false against every threshold, so a
    // malformed row would silently land on the healthy side.
    const bad = [
      { source_name: 'a', total: Number.NaN, dropped: 5 },
      { source_name: 'b', total: 100, dropped: Number.NaN },
      { source_name: 'c', total: -1, dropped: 5 },
    ] as SourceDropStats[]
    const d = decideEmailDropAlert(bad, OPTS)
    expect(d.alert).toBe(false)
    expect(d.unusable.sort()).toEqual(['a', 'b', 'c'])
  })

  it('still judges the usable rows beside an unusable one', () => {
    const mixed = [
      { source_name: 'broken_row', total: Number.NaN, dropped: 1 },
      { source_name: 'real', total: 1000, dropped: 300 },
    ] as SourceDropStats[]
    const d = decideEmailDropAlert(mixed, OPTS)
    expect(d.alert).toBe(true)
    expect(d.offenders.map((o) => o.source)).toEqual(['real'])
    expect(d.unusable).toEqual(['broken_row'])
  })

  it('never reports more dropped than total as a rate above one', () => {
    // Defensive: a bad aggregation should be flagged, not rendered as 300%.
    const d = decideEmailDropAlert(rows(['weird', 10, 50]), OPTS)
    expect(d.unusable).toEqual(['weird'])
    expect(d.alert).toBe(false)
  })

  it('labels a null source rather than dropping the row silently', () => {
    const d = decideEmailDropAlert(rows([null, 1000, 500]), OPTS)
    expect(d.alert).toBe(true)
    expect(d.offenders[0].source).toBe('(no source)')
  })
})

// ── The scheduled orchestration ──────────────────────────────────────────────
//
// The pure decision above is only half of it. These cover the parts that decide
// whether anybody is actually told: which organizations get checked, whether the
// cooldown suppresses a repeat, and what happens when Slack or the query fails.
// Each of those is a path a green pure-function suite would say nothing about.

import { vi, beforeEach, afterEach } from 'vitest'

const postMessage = vi.hoisted(() => vi.fn())
const getSlackConnection = vi.hoisted(() => vi.fn())

vi.mock('../slack', () => ({ postMessage, getSlackConnection }))

const { runEmailDropRateCheck } = await import('../email-drop-rate')

function makeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
  }
}

/** Supabase double: `service_connections` lists the orgs, `rpc` returns counts. */
function makeSupabase(opts: {
  orgs?: string[]
  orgsError?: string
  rpc?: (orgId: string) => { data: unknown; error: { message: string } | null }
}) {
  const rpcCalls: string[] = []
  const client = {
    from: () => ({
      select: () => ({
        eq: async () => ({
          data: opts.orgsError ? null : (opts.orgs ?? ['org-1']).map((organization_id) => ({ organization_id })),
          error: opts.orgsError ? { message: opts.orgsError } : null,
        }),
      }),
    }),
    rpc: vi.fn(async (_fn: string, args: { p_org_id: string }) => {
      rpcCalls.push(args.p_org_id)
      return opts.rpc ? opts.rpc(args.p_org_id) : { data: [], error: null }
    }),
  }
  return { client: client as never, rpcCalls }
}

const OVER = [{ source_name: 'partner_a', total: 1000, dropped: 300 }]
const UNDER = [{ source_name: 'partner_a', total: 1000, dropped: 1 }]

beforeEach(() => {
  vi.clearAllMocks()
  getSlackConnection.mockResolvedValue({ bot_token: 't', default_channel: '#c', volume_alerts_enabled: true })
  postMessage.mockResolvedValue('ts-1')
})
afterEach(() => { vi.restoreAllMocks() })

describe('runEmailDropRateCheck: who gets told (#744)', () => {
  it('posts to Slack and names the source when a source is over threshold', async () => {
    const kv = makeKv()
    const db = makeSupabase({ rpc: () => ({ data: OVER, error: null }) })
    await runEmailDropRateCheck(db.client, kv)
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(postMessage.mock.calls[0])).toContain('partner_a')
    // #835: the rule is a fixed rate, not a change against a baseline, so the
    // alert may not call it a sudden rise.
    expect(JSON.stringify(postMessage.mock.calls[0])).not.toMatch(/sudden rise/)
    expect(JSON.stringify(postMessage.mock.calls[0])).toContain('at or above the 5% this alert allows')
  })

  it('says nothing when every source is within threshold', async () => {
    const kv = makeKv()
    const db = makeSupabase({ rpc: () => ({ data: UNDER, error: null }) })
    await runEmailDropRateCheck(db.client, kv)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('checks every organization that has Slack connected', async () => {
    const kv = makeKv()
    const db = makeSupabase({ orgs: ['org-1', 'org-2', 'org-3'], rpc: () => ({ data: UNDER, error: null }) })
    await runEmailDropRateCheck(db.client, kv)
    expect(db.rpcCalls.sort()).toEqual(['org-1', 'org-2', 'org-3'])
  })

  it('does nothing when no organization has Slack connected', async () => {
    const kv = makeKv()
    const db = makeSupabase({ orgs: [] })
    await runEmailDropRateCheck(db.client, kv)
    expect(db.rpcCalls).toEqual([])
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('respects the volume-alerts toggle being off', async () => {
    getSlackConnection.mockResolvedValue({ bot_token: 't', default_channel: '#c', volume_alerts_enabled: false })
    const kv = makeKv()
    const db = makeSupabase({ rpc: () => ({ data: OVER, error: null }) })
    await runEmailDropRateCheck(db.client, kv)
    expect(postMessage).not.toHaveBeenCalled()
  })
})

describe('runEmailDropRateCheck: failure paths (#744)', () => {
  it('does not alert when the counts query fails, and does not throw', async () => {
    const kv = makeKv()
    const db = makeSupabase({ rpc: () => ({ data: null, error: { message: 'boom' } }) })
    await expect(runEmailDropRateCheck(db.client, kv)).resolves.toBeUndefined()
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('reports a failed query as a FAILURE, never as a window with no leads in it', async () => {
    // Found by mutation-checking: without the error branch the failed query falls
    // through to an empty row set, which the decision correctly calls
    // `no_executions`, and the check then logs that it measured a quiet window. A
    // message may claim only what its check actually measured (LESSONS L11), and
    // "no leads today" is a very different thing to tell someone than "I could not
    // ask". Removing the branch changes no alert, only what the log claims, which
    // is exactly why asserting on the alert alone missed it.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const kv = makeKv()
    const db = makeSupabase({ rpc: () => ({ data: null, error: { message: 'boom' } }) })

    await runEmailDropRateCheck(db.client, kv)

    const errors = err.mock.calls.map((c) => String(c[0]))
    const logs = log.mock.calls.map((c) => String(c[0]))
    expect(errors.some((l) => l.includes('event=email_drop_query_failed'))).toBe(true)
    expect(logs.some((l) => l.includes('reason=no_executions'))).toBe(false)
  })

  it('does not throw when the organization lookup itself fails', async () => {
    const kv = makeKv()
    const db = makeSupabase({ orgsError: 'connection refused' })
    await expect(runEmailDropRateCheck(db.client, kv)).resolves.toBeUndefined()
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('keeps checking the other organizations when one throws', async () => {
    // Independent steps sharing one handler each need their own failure boundary,
    // or an unguarded throw on the first silently cancels every one after it, and
    // the ones lost are unrelated to the one that broke (LESSONS L73).
    const kv = makeKv()
    const db = makeSupabase({
      orgs: ['bad', 'good'],
      rpc: (org) => {
        if (org === 'bad') throw new Error('org exploded')
        return { data: OVER, error: null }
      },
    })
    await expect(runEmailDropRateCheck(db.client, kv)).resolves.toBeUndefined()
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('does NOT set the cooldown when Slack reports the message was not sent', async () => {
    // Setting it optimistically would swallow the single notification whenever
    // Slack was briefly unavailable, then stay quiet for a whole day (LESSONS L12).
    postMessage.mockResolvedValue(null)
    const kv = makeKv()
    const db = makeSupabase({ rpc: () => ({ data: OVER, error: null }) })
    await runEmailDropRateCheck(db.client, kv)
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('does NOT set the cooldown when the Slack call throws', async () => {
    postMessage.mockRejectedValue(new Error('network down'))
    const kv = makeKv()
    const db = makeSupabase({ rpc: () => ({ data: OVER, error: null }) })
    await expect(runEmailDropRateCheck(db.client, kv)).resolves.toBeUndefined()
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('still alerts the other offenders when one send throws', async () => {
    postMessage.mockRejectedValueOnce(new Error('network down')).mockResolvedValue('ts-2')
    const kv = makeKv()
    const db = makeSupabase({
      rpc: () => ({ data: [
        { source_name: 'worst', total: 1000, dropped: 900 },
        { source_name: 'second', total: 1000, dropped: 300 },
      ], error: null }),
    })
    await runEmailDropRateCheck(db.client, kv)
    expect(postMessage).toHaveBeenCalledTimes(2)
  })
})

describe('runEmailDropRateCheck: the cooldown (#744)', () => {
  it('sets a cooldown after a confirmed send', async () => {
    const kv = makeKv()
    const db = makeSupabase({ rpc: () => ({ data: OVER, error: null }) })
    await runEmailDropRateCheck(db.client, kv)
    expect(kv.put).toHaveBeenCalledTimes(1)
  })

  it('stays silent on the next run while the cooldown holds', async () => {
    const kv = makeKv()
    const db = makeSupabase({ rpc: () => ({ data: OVER, error: null }) })
    await runEmailDropRateCheck(db.client, kv)
    await runEmailDropRateCheck(db.client, kv)
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('keys the cooldown per source, so one noisy partner cannot mute another', () => {
    const kv = makeKv()
    const db = makeSupabase({
      rpc: () => ({ data: [
        { source_name: 'a', total: 1000, dropped: 300 },
        { source_name: 'b', total: 1000, dropped: 400 },
      ], error: null }),
    })
    return runEmailDropRateCheck(db.client, kv).then(() => {
      expect(postMessage).toHaveBeenCalledTimes(2)
      expect([...kv.store.keys()].length).toBe(2)
    })
  })

  it('keys the cooldown per organization as well as per source', async () => {
    const kv = makeKv()
    const db = makeSupabase({ orgs: ['org-1', 'org-2'], rpc: () => ({ data: OVER, error: null }) })
    await runEmailDropRateCheck(db.client, kv)
    // Same source name in two orgs is two different partners' worth of leads.
    expect(postMessage).toHaveBeenCalledTimes(2)
    expect([...kv.store.keys()].length).toBe(2)
  })
})
