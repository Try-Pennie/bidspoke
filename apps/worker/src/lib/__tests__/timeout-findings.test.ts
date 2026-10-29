/**
 * What the daily Step Timeout Warnings alert lists, judged over five days (#2934).
 *
 * Every fixture here is measured from production (read only, 2026-10-29), with
 * times as the runs started, in UTC. Eastern was UTC-4 on these dates.
 *
 * 2026-10-28 4:17 AM ET: the alert judged Engine Bidding's equifax_credit_report
 * on the two hours before it (p99 19,232 ms against a 7,500 ms timeout) and
 * suggested 29,000 ms. Over the day its p99 was 1,459 ms: a slowdown, not a
 * timeout set too low.
 *
 * 2026-10-29 4:17 AM ET: the alert missed Main Flow's Credit Collections
 * (collections_apex), which has no retries and lost 7 runs to its 4,500 ms
 * timeout. The audit only measured runs that finished, so the runs the timeout
 * cut off were never in its sample, and a finished run of a no retries step can
 * never be slower than its timeout. It listed Tripoint SF POST on one slow day,
 * with one run lost in five days.
 *
 * 2026-10-29 10:41 AM to 12:08 PM ET: outbound calls hung across Equifax,
 * Salesforce, Pipedream and GigFi. GigFi's ping lost 9 runs inside that window
 * and none outside it.
 */
import { describe, it, expect } from 'vitest'
import {
  AUDIT_PERIOD_DAYS,
  OUTAGE_BURST_MS,
  TIMED_OUT_RUNS_TO_LIST,
  densestBurst,
  findPeriodFindings,
  periodFindingsSignature,
  type PeriodStepStats,
} from '../timeout-findings'
import type { NodeDefinition, WorkflowDefinition } from '../../types'

function def(nodes: Array<Partial<NodeDefinition> & { id: string; type: NodeDefinition['type'] }>): WorkflowDefinition {
  return {
    id: 'wf', name: 'wf', trigger: {} as WorkflowDefinition['trigger'], edges: [],
    nodes: nodes.map((n) => ({ namespace: n.id, config: {}, ...n })) as NodeDefinition[],
  }
}

/** Eastern wall clock on 2026-10-DD (EDT, UTC-4) to the UTC instant the database stores. */
function et(day: number, hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(Date.UTC(2026, 9, day, h + 4, m)).toISOString()
}
function ets(list: string): string[] {
  return list.trim().split(/\s+/).reduce<string[]>((out, tok, i, all) => (i % 2 === 0 ? [...out, et(Number(tok), all[i + 1])] : out), [])
}

function stats(p: Partial<PeriodStepStats>): PeriodStepStats {
  return { p50: null, p99: null, max_ms: null, sample_size: 0, timed_out: 0, timed_out_at: [], ...p }
}

describe('the rules Dan set on 2026-10-29', () => {
  it('judges five days, lists a step at two timed out runs, and calls a burst short at two hours', () => {
    expect(AUDIT_PERIOD_DAYS).toBe(5)
    expect(TIMED_OUT_RUNS_TO_LIST).toBe(2)
    expect(OUTAGE_BURST_MS).toBe(2 * 60 * 60 * 1000)
  })
})

describe('2026-10-29 4:17 AM ET, Main Flow', () => {
  const mainFlow = def([
    { id: 'collections_apex', type: 'salesforce', label: 'Credit Collections', config: { timeout_ms: 4500, retries: 0 } },
    { id: 'tripoint_sf_post', type: 'webhook', label: 'Tripoint SF POST', config: { timeout_ms: 3750, retries: 2 } },
    { id: 'engine_no_bids_call', type: 'code', label: 'Engine No Bids Call', config: { timeout_ms: 43500, retries: 2 } },
    { id: 'send_salesforce', type: 'salesforce', label: 'Send Salesforce', config: { timeout_ms: 5250, retries: 0 } },
  ])
  const measured = new Map<string, PeriodStepStats>([
    // Five day even sample: p99 2,636, slowest finished 3,427 over 475 runs. The
    // seven runs cut off at 4,500 ms are what the old sample could not see.
    ['collections_apex', stats({
      p50: 900, p99: 2636, max_ms: 3427, sample_size: 475, timed_out: 7,
      timed_out_at: ets('28 11:52 28 11:52 28 11:52 28 11:52 28 11:53 28 12:36 29 02:25'),
    })],
    // p99 926 over five days; the one slow day gave it 3,946. One run lost.
    ['tripoint_sf_post', stats({ p50: 120, p99: 926, max_ms: 12259, sample_size: 1453, timed_out: 1, timed_out_at: ets('28 07:17') })],
    // Nothing lost; 43,500 sits above its p99 of 31,236 but under p99 x 1.5.
    ['engine_no_bids_call', stats({ p50: 18000, p99: 31236, max_ms: 39773, sample_size: 955 })],
    ['send_salesforce', stats({
      p50: 1500, p99: 3454, max_ms: 4765, sample_size: 2783, timed_out: 9,
      timed_out_at: ets('27 12:44 27 19:57 28 02:28 28 06:50 28 06:58 28 07:09 28 07:25 28 07:55 28 07:59'),
    })],
  ])
  const found = findPeriodFindings(mainFlow, measured)
  const byNs = new Map(found.map((f) => [f.namespace, f]))

  it('lists a no retries step that lost runs to its timeout, though no finished run was slower than it', () => {
    expect(byNs.get('collections_apex')).toMatchObject({
      kind: 'losing_runs', configured_ms: 4500, retries: 0, timed_out: 7, latest_at: et(29, '02:25'),
      burst: { count: 6, start: et(28, '11:52'), end: et(28, '12:36') },
    })
  })

  it('does not suggest a value the finished runs do not support', () => {
    // p99 x 1.5 = 3,954 and slowest x 1.05 = 3,598, both under 4,500.
    expect(byNs.get('collections_apex')).toMatchObject({ suggested_ms: null })
  })

  it('does not list a step for a single unlucky run', () => {
    expect(byNs.has('tripoint_sf_post')).toBe(false)
  })

  it('lists thin headroom in its own lower urgency kind', () => {
    expect(byNs.get('engine_no_bids_call')).toMatchObject({ kind: 'headroom', severity: 'amber', suggested_ms: 47000, p99_ms: 31236, sample_size: 955 })
  })

  it('a step losing runs is listed once, as losing runs, never again as headroom', () => {
    expect(found.filter((f) => f.namespace === 'send_salesforce')).toHaveLength(1)
    expect(byNs.get('send_salesforce')).toMatchObject({ kind: 'losing_runs', timed_out: 9 })
  })

  it('puts the step that lost most runs first', () => {
    expect(found.filter((f) => f.kind === 'losing_runs').map((f) => f.namespace)).toEqual(['send_salesforce', 'collections_apex'])
  })
})

describe('2026-10-28 4:17 AM ET, Engine Bidding: a slowdown inside five quiet days', () => {
  const engine = def([{ id: 'equifax_credit_report', type: 'code', label: 'Equifax Credit Report', config: { timeout_ms: 7500, retries: 2 } }])

  it('suggests no higher timeout when the slow runs all came in one two hour patch', () => {
    // A two hour slowdown: every lost run between 2:17 and 4:17 AM, five days of
    // quick runs around it.
    const found = findPeriodFindings(engine, new Map([['equifax_credit_report', stats({
      p50: 700, p99: 1459, max_ms: 19232, sample_size: 1200, timed_out: 6,
      timed_out_at: ets('28 02:21 28 02:21 28 02:41 28 03:01 28 03:17 28 04:10'),
    })]]))
    expect(found).toEqual([expect.objectContaining({ kind: 'outage', timed_out: 6, start: et(28, '02:21'), end: et(28, '04:10') })])
    expect(found[0]).not.toHaveProperty('suggested_ms')
  })

  it('lists the runs it really lost that night, still without a higher timeout', () => {
    // As measured at 4:17 AM: runs lost on the 26th and 27th too, so not one burst.
    const found = findPeriodFindings(engine, new Map([['equifax_credit_report', stats({
      p50: 700, p99: 1459, max_ms: 19232, sample_size: 1200, timed_out: 25,
      timed_out_at: ets(`26 20:03 26 20:03 27 15:01 28 00:05 28 00:09 28 00:27 28 00:28 28 00:56 28 01:06 28 01:36
        28 01:59 28 02:21 28 02:21 28 02:41 28 03:01 28 03:02 28 03:17 28 03:18 28 03:23 28 03:27 28 03:29 28 03:32
        28 03:33 28 03:38 28 03:56`),
    })]]))
    expect(found).toEqual([expect.objectContaining({ kind: 'losing_runs', timed_out: 25, suggested_ms: null })])
  })
})

describe('2026-10-29 10:41 AM to 12:08 PM ET, the outage where outbound calls hung', () => {
  const gigfi = def([{ id: 'ping_gigfi', type: 'webhook', label: 'Ping GigFi', config: { timeout_ms: 3000, retries: 0 } }])

  it('reads a step whose lost runs all fall inside one burst as an incident, with its window', () => {
    const found = findPeriodFindings(gigfi, new Map([['ping_gigfi', stats({
      p50: 300, p99: 2400, max_ms: 2900, sample_size: 900, timed_out: 9,
      timed_out_at: ets('29 10:42 29 10:43 29 10:44 29 10:51 29 10:54 29 10:59 29 11:10 29 11:24 29 11:31'),
    })]]))
    expect(found).toEqual([{
      kind: 'outage', node_id: 'ping_gigfi', namespace: 'ping_gigfi', label: 'Ping GigFi', type: 'webhook',
      configured_ms: 3000, timed_out: 9, start: et(29, '10:42'), end: et(29, '11:31'),
    }])
  })

  it('does not call it one burst once the runs spread past two hours', () => {
    const found = findPeriodFindings(gigfi, new Map([['ping_gigfi', stats({
      p50: 300, p99: 2400, max_ms: 2900, sample_size: 900, timed_out: 3,
      timed_out_at: ets('29 10:42 29 11:31 29 12:43'),
    })]]))
    expect(found).toEqual([expect.objectContaining({ kind: 'losing_runs', timed_out: 3, burst: { count: 2, start: et(29, '11:31'), end: et(29, '12:43') } })])
  })

  it('a step the outage hit that had lost runs before it stays listed, its outage runs named', () => {
    // Credit Collections as the next morning's alert will read it.
    const apex = def([{ id: 'collections_apex', type: 'salesforce', label: 'Credit Collections', config: { timeout_ms: 4500, retries: 0 } }])
    const times = ets(`28 11:52 28 11:52 28 11:52 28 11:52 28 11:53 28 12:36 29 02:25 29 10:42 29 10:42 29 10:44 29 10:46
      29 10:48 29 10:53 29 10:54 29 10:56 29 10:58 29 11:16 29 11:22 29 11:22 29 11:26 29 11:26 29 11:26 29 11:32 29 11:37
      29 11:42 29 11:42 29 11:43 29 11:43 29 11:45 29 11:48 29 11:56 29 12:00 29 12:06`)
    const found = findPeriodFindings(apex, new Map([['collections_apex', stats({ p50: 900, p99: 2636, max_ms: 3427, sample_size: 475, timed_out: times.length, timed_out_at: times })]]))
    expect(found).toEqual([expect.objectContaining({ kind: 'losing_runs', timed_out: 33, burst: { count: 26, start: et(29, '10:42'), end: et(29, '12:06') } })])
  })

  it('cannot call runs one burst when it was handed only some of their times', () => {
    // The function returns at most the most recent 1,000 times; a count above
    // that is a step losing runs, never an incident judged on part of them.
    const found = findPeriodFindings(gigfi, new Map([['ping_gigfi', stats({
      p50: 300, p99: 2400, max_ms: 2900, sample_size: 900, timed_out: 1500,
      timed_out_at: ets('29 10:42 29 10:43'),
    })]]))
    expect(found).toEqual([expect.objectContaining({ kind: 'losing_runs', timed_out: 1500 })])
  })
})

describe('a reading that counts lost runs but carries no readable time for them', () => {
  it('still lists the step, without a latest time or a burst, rather than throwing', () => {
    const d = def([{ id: 'w', type: 'webhook', label: 'W', config: { timeout_ms: 3000, retries: 0 } }])
    const found = findPeriodFindings(d, new Map([['w', stats({ p99: 100, max_ms: 200, sample_size: 500, timed_out: 3, timed_out_at: ['not a time'] })]]))
    expect(found).toEqual([expect.objectContaining({ kind: 'losing_runs', timed_out: 3, latest_at: null, burst: null })])
  })
})

describe('what is never listed by the period findings', () => {
  it('a step below the reliable minimum, which has its own section', () => {
    const d = def([{ id: 'c', type: 'code', config: { timeout_ms: 20, retries: 0 } }])
    expect(findPeriodFindings(d, new Map([['c', stats({ p99: 10, max_ms: 15, sample_size: 500, timed_out: 4, timed_out_at: ets('27 01:00 27 09:00 28 01:00 28 09:00') })]]))).toEqual([])
  })

  it('a step with no timeout set, or no runs at all', () => {
    const d = def([{ id: 'a', type: 'webhook', config: {} }, { id: 'b', type: 'webhook', config: { timeout_ms: 1000 } }])
    expect(findPeriodFindings(d, new Map([['a', stats({ timed_out: 3, timed_out_at: ets('27 01:00 28 01:00 29 01:00') })]]))).toEqual([])
  })

  it('headroom on a thin sample', () => {
    const d = def([{ id: 'w', type: 'webhook', config: { timeout_ms: 1000, retries: 2 } }])
    expect(findPeriodFindings(d, new Map([['w', stats({ p99: 900, max_ms: 950, sample_size: 9 })]]))).toEqual([])
  })
})

describe('densestBurst', () => {
  it('finds the two hour window holding most runs, the latest when two tie', () => {
    const t = ets('27 01:00 27 01:30 28 05:00 28 05:10').map((s) => Date.parse(s))
    expect(densestBurst(t, OUTAGE_BURST_MS)).toEqual({ count: 2, start: Date.parse(et(28, '05:00')), end: Date.parse(et(28, '05:10')) })
  })

  it('counts a run exactly two hours after the first as inside', () => {
    const t = ets('27 01:00 27 03:00').map((s) => Date.parse(s))
    expect(densestBurst(t, OUTAGE_BURST_MS)?.count).toBe(2)
  })

  it('is nothing for no runs', () => {
    expect(densestBurst([], OUTAGE_BURST_MS)).toBeNull()
  })
})

describe('periodFindingsSignature', () => {
  const findings = (timedOut: number) => [{
    workflow_id: 'wf', workflow_name: 'Main Flow',
    findings: findPeriodFindings(
      def([{ id: 'p', type: 'webhook', config: { timeout_ms: 3000, retries: 0 } }]),
      new Map([['p', stats({ p99: 100, max_ms: 200, sample_size: 500, timed_out: timedOut, timed_out_at: ets('29 10:42 29 10:43 29 10:44').slice(0, timedOut) })]]),
    ),
  }]

  it('names the step, its setting and its kind, never the counts that move each day', () => {
    expect(periodFindingsSignature(findings(2))).toBe(periodFindingsSignature(findings(3)))
  })

  it('a new incident on the same step is a new signature', () => {
    const later = [{ ...findings(2)[0], findings: findings(2)[0].findings.map((f) => ({ ...f, start: et(30, '09:00') })) }]
    expect(periodFindingsSignature(later)).not.toBe(periodFindingsSignature(findings(2)))
  })
})
