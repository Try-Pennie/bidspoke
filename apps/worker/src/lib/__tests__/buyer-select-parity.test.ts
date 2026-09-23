/**
 * The Stage A parity summary (#1413, PR 3): per Eastern day, what the
 * buyer_select node decided beside what the incumbent tripoint_ping step did in
 * the same execution, counted into the buyer_select_parity_days row.
 *
 * Every comparison names what it could not measure rather than counting it as
 * agreement (L11, L90): a missing hash on either side is hash_unmeasured, an
 * execution with one of the two rows missing is unpaired, and the counts the
 * node does not yet expose (state, rehearsal heals) are listed as unmeasured.
 * The row's hash covers the counts only, so a sign off can be tied to the
 * numbers it approved (L641). A day is complete only when its Eastern midnight
 * has passed AND the purge has not yet reached it (L696, L202).
 */
import { describe, expect, it } from 'vitest'
import { RETENTION_DAYS } from '../../archive/candidate-days'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PAGE_SIZE } from '../paginate'
import {
  INCUMBENT_NAMESPACE,
  countsHash,
  productionReadDeps,
  readParityDay,
  refreshableDays,
  runParityRefresh,
  runParityRefreshAndPage,
  summariseParityDay,
  windowComplete,
  type ParityExecution,
  type ParityRowWrite,
  type ParityRules,
  type RefreshDeps,
} from '../buyer-select-parity'

const RULES: ParityRules = {
  accept: [{ field: 'ok', equals: true }, { field: 'data.createLead.resultCode', in: [1000, 1001, 1013, 1014, 1015, 1016, 1017] }],
  decline: [{ field: 'data.createLead.resultCode', in: [1002, 1003, 1004, 1005, 1020] }],
}

const T0 = '2027-09-20T15:30:00.000Z'

function exec(id: string, over: Partial<ParityExecution> = {}): ParityExecution {
  return {
    execution_id: id,
    started_at: T0,
    node: { _route: 'deferred', reason: 'decide_only', mode_effective: 'decide_only', would_send_body_sha256: 'a'.repeat(64), lead_state: 'TX' },
    node_duration_ms: 120,
    incumbent: { skipped: false, qualified: true, resultCode: 1000, sent_body_sha256: 'a'.repeat(64), debug: { httpStatus: 200, rawText: '{"ok":true,"data":{"createLead":{"resultCode":1000,"id":"L-1"}}}' } },
    ...over,
  }
}

describe('summariseParityDay', () => {
  it('counts a sell off decision that matches the incumbent as agreement, and one that does not as a disagreement naming the execution', () => {
    const counts = summariseParityDay([
      exec('e1'),
      exec('e2', { node: { _route: 'not_applicable', reason: 'sell_off_false', mode_effective: 'decide_only', lead_state: 'CA' }, incumbent: { skipped: true, qualified: null, resultCode: null } }),
      exec('e3', { node: { _route: 'not_applicable', reason: 'bid_not_positive', mode_effective: 'decide_only', lead_state: 'CA' } }),
    ], RULES)
    expect(counts.sell_off_agree).toBe(2)
    expect(counts.sell_off_disagree).toBe(1)
    expect(counts.disagreement_execution_ids).toContain('e3')
    expect(counts.disagreement_execution_ids).not.toContain('e1')
  })

  it('compares the body hashes only when both sides carry one; a missing side is unmeasured, never a match', () => {
    const counts = summariseParityDay([
      exec('e1'),
      exec('e2', { incumbent: { skipped: false, qualified: true, resultCode: 1000, sent_body_sha256: 'b'.repeat(64), debug: { httpStatus: 200, rawText: '{"ok":true,"data":{"createLead":{"resultCode":1000}}}' } } }),
      exec('e3', { incumbent: { skipped: false, qualified: true, resultCode: 1000, debug: { httpStatus: 200, rawText: '{"ok":true,"data":{"createLead":{"resultCode":1000}}}' } } }),
      exec('e4', { node: { _route: 'deferred', reason: 'decide_only', mode_effective: 'decide_only', lead_state: 'TX' } }),
    ], RULES)
    expect(counts).toMatchObject({ hash_match: 1, hash_mismatch: 1, hash_unmeasured: 2 })
    expect(counts.disagreement_execution_ids).toEqual(['e2'])
  })

  it('replays the classifier over what the incumbent recorded and compares it with what the incumbent concluded', () => {
    const declinedBody = '{"ok":true,"data":{"createLead":{"resultCode":1003}}}'
    const unknownBody = '{"ok":true,"data":{"createLead":{"resultCode":1999}}}'
    const counts = summariseParityDay([
      exec('e1'),
      // The incumbent said declined (qualified false, 1003) and the rules agree.
      exec('e2', { incumbent: { skipped: false, qualified: false, resultCode: 1003, debug: { httpStatus: 200, rawText: declinedBody } } }),
      // The incumbent said qualified but the rules would decline: a disagreement.
      exec('e3', { incumbent: { skipped: false, qualified: true, resultCode: 1003, debug: { httpStatus: 200, rawText: declinedBody } } }),
      // Neither an accept nor a decline rule matches: the classifier cannot say, and that is its own count.
      exec('e4', { incumbent: { skipped: false, qualified: false, resultCode: 1999, debug: { httpStatus: 200, rawText: unknownBody } } }),
      // Skipped: nothing to classify.
      exec('e5', { node: { _route: 'not_applicable', reason: 'sell_off_false', mode_effective: 'decide_only', lead_state: 'CA' }, incumbent: { skipped: true, qualified: null, resultCode: null } }),
    ], RULES)
    expect(counts).toMatchObject({ classification_agree: 2, classification_disagree: 1, outcome_unknown_count: 1 })
    expect(counts.disagreement_execution_ids).toEqual(expect.arrayContaining(['e3', 'e4']))
    expect(counts.disagreement_execution_ids).not.toContain('e2')
  })

  it('an incumbent row without the recorded response is unmeasured for classification, not agreement', () => {
    const counts = summariseParityDay([exec('e1', { incumbent: { skipped: false, qualified: true, resultCode: 1000 } })], RULES)
    expect(counts.classification_agree + counts.classification_disagree + counts.outcome_unknown_count).toBe(0)
    expect(counts.unmeasured).toContain('classification:1 execution without a recorded response')
  })

  it('counts the state the node resolved, and lists state as unmeasured when the node does not expose it', () => {
    const counts = summariseParityDay([
      exec('e1'),
      exec('e2', { node: { _route: 'deferred', reason: 'decide_only', mode_effective: 'decide_only', would_send_body_sha256: 'a'.repeat(64), lead_state: null } }),
    ], RULES)
    expect(counts).toMatchObject({ state_resolved: 1, state_unresolved: 1 })
    const older = summariseParityDay([exec('e1', { node: { _route: 'deferred', reason: 'decide_only', mode_effective: 'decide_only' } })], RULES)
    expect(older.unmeasured).toContain('state:1 execution from a node version that did not record it')
  })

  it('the rehearsal heal and expired claim counts are unmeasured until the node records them, never zero passed off as measured (L90)', () => {
    const counts = summariseParityDay([exec('e1')], RULES)
    expect(counts.rehearsal_in_doubt_heals).toBe(0)
    expect(counts.unmeasured).toEqual(expect.arrayContaining(['rehearsal_in_doubt_heals', 'rehearsal_expired_in_flight']))
  })

  it('records the decide only latency percentiles over the node durations, null when there were none', () => {
    const counts = summariseParityDay([100, 200, 300, 400, 1000].map((ms, i) => exec(`e${i}`, { node_duration_ms: ms })), RULES)
    expect(counts.decide_only_latency_p50_ms).toBe(300)
    expect(counts.decide_only_latency_p95_ms).toBe(1000)
    expect(summariseParityDay([], RULES).decide_only_latency_p50_ms).toBeNull()
  })

  it('an execution with one of the two rows missing is unpaired and compared on nothing', () => {
    const counts = summariseParityDay([exec('e1', { incumbent: null }), exec('e2', { node: null, node_duration_ms: null })], RULES)
    expect(counts.executions_unpaired).toBe(2)
    expect(counts.sell_off_agree + counts.sell_off_disagree).toBe(0)
    expect(INCUMBENT_NAMESPACE).toBe('tripoint_ping')
  })
})

describe('windowComplete', () => {
  // 2027-09-20 15:30 UTC is 11:30 Eastern on the 20th.
  const NOW = Date.parse(T0)
  it('is false for the day still being written, true for a fully elapsed day inside retention, false for a day the purge has reached (L696, L202)', () => {
    expect(windowComplete('2027-09-20', NOW, RETENTION_DAYS)).toBe(false)
    expect(windowComplete('2027-09-19', NOW, RETENTION_DAYS)).toBe(true)
    expect(windowComplete(`2027-09-${20 - RETENTION_DAYS}`, NOW, RETENTION_DAYS)).toBe(false)
    expect(windowComplete(`2027-09-${21 - RETENTION_DAYS}`, NOW, RETENTION_DAYS)).toBe(true)
  })
})

describe('runParityRefresh', () => {
  const NOW = Date.parse(T0)
  const WF = { id: 'wf-engine', organization_id: 'org-1' }

  function refreshDeps(over: Partial<RefreshDeps> = {}) {
    const upserts: ParityRowWrite[] = []
    const deps: RefreshDeps = {
      listWorkflows: async () => [WF],
      rules: async () => RULES,
      read: {
        countNodeRows: async () => 1,
        // The ET day 2027-09-20 starts at 04:00Z and is read in three hour windows; the 13:00Z window holds the one execution.
        listExecutions: async (_wf, fromIso) => (fromIso.startsWith('2027-09-20T13') ? [{ id: 'e1', started_at: fromIso }] : []),
        readRows: async (ids) => ids.flatMap((id) => [
          { execution_id: id, step_type: 'buyer_select', step_namespace: 'sell_off', output: exec(id).node, duration_ms: 120 },
          { execution_id: id, step_type: 'code', step_namespace: INCUMBENT_NAMESPACE, output: exec(id).incumbent, duration_ms: 900 },
        ]),
      },
      upsert: async (row) => { upserts.push(row); return row },
      now: () => NOW,
      retentionDays: RETENTION_DAYS,
      localDev: false,
      log: () => {},
      ...over,
    }
    return { deps, upserts }
  }

  it('writes one row per workflow and refreshable day, with the counts, the hash and the window flag, and never a sign off column', async () => {
    const { deps, upserts } = refreshDeps()
    const summary = await runParityRefresh(deps)
    // Today and yesterday only (#1497): a day's step rows never change once it
    // is over, so older days keep the row they have, and re-reading every day
    // inside retention each hour at the Engine flow's volume would spend the
    // invocation's subrequest budget.
    expect(summary.rows_written).toBe(2)
    const today = upserts.find((r) => r.et_day === '2027-09-20')
    expect(today).toMatchObject({ workflow_id: 'wf-engine', organization_id: 'org-1', sell_off_agree: 1, hash_match: 1, classification_agree: 1, window_complete: false })
    expect(today?.counts_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.keys(today ?? {})).not.toContain('signed_off_at')
    const yesterday = upserts.find((r) => r.et_day === '2027-09-19')
    expect(yesterday).toMatchObject({ sell_off_agree: 0, window_complete: true })
  })

  it('a day whose reads fail is reported by name and the other days are still written (L98)', async () => {
    const { deps, upserts } = refreshDeps({
      read: {
        countNodeRows: async () => 1,
        // The ET day 2027-09-19 runs from 2027-09-19T04:00Z to 2027-09-20T04:00Z; every window inside it fails.
        listExecutions: async (_wf, fromIso) => { if (fromIso >= '2027-09-19T04:00' && fromIso < '2027-09-20T04:00') throw new Error('execution_steps: statement timeout'); return [] },
        readRows: async () => [],
      },
    })
    const summary = await runParityRefresh(deps)
    expect(summary.errors.join(' ')).toMatch(/2027-09-19.*statement timeout/)
    expect(upserts.map((r) => r.et_day)).not.toContain('2027-09-19')
    expect(upserts.length).toBe(1)
  })

  it('a workflow whose buyer has no rules is skipped by name rather than classified against nothing', async () => {
    const { deps, upserts } = refreshDeps({ rules: async () => null })
    const summary = await runParityRefresh(deps)
    expect(upserts).toEqual([])
    expect(summary.errors.join(' ')).toMatch(/wf-engine.*no accept and decline rules/)
  })

  it('does nothing in local dev, and says so', async () => {
    const { deps, upserts } = refreshDeps({ localDev: true })
    const summary = await runParityRefresh(deps)
    expect(summary.skipped).toBe('local_dev')
    expect(upserts).toEqual([])
  })

  it('a run with failed days pages them and a clean run clears the condition; a skipped run says nothing either way (L13)', async () => {
    const failing = refreshDeps({
      read: {
        countNodeRows: async () => 1,
        listExecutions: async (_wf, fromIso) => { if (fromIso >= '2027-09-19T04:00' && fromIso < '2027-09-20T04:00') throw new Error('execution_steps: statement timeout'); return [] },
        readRows: async () => [],
      },
    })
    const paged: string[][] = []
    const notify = async (lines: string[]) => { paged.push(lines) }
    await runParityRefreshAndPage(failing.deps, notify)
    expect(paged).toHaveLength(1)
    expect(paged[0].join(' ')).toMatch(/wf-engine 2027-09-19.*statement timeout/)
    const clean = refreshDeps()
    await runParityRefreshAndPage(clean.deps, notify)
    expect(paged[1]).toEqual([])
    const skipped = refreshDeps({ localDev: true })
    await runParityRefreshAndPage(skipped.deps, notify)
    expect(paged).toHaveLength(2)
  })

  it('a run scoped to one workflow or one day neither pages nor clears: its answer is the response, and only a full run speaks for the whole job', async () => {
    const paged: string[][] = []
    const notify = async (lines: string[]) => { paged.push(lines) }
    const clean = refreshDeps()
    await runParityRefreshAndPage(clean.deps, notify, { day: '2027-09-19' })
    await runParityRefreshAndPage(clean.deps, notify, { workflowId: 'wf-engine' })
    expect(paged).toEqual([])
  })
})

describe('countsHash', () => {
  it('is stable for the same counts, changes when a count changes, and ignores the bookkeeping columns', async () => {
    const a = summariseParityDay([exec('e1')], RULES)
    const b = summariseParityDay([exec('e1')], RULES)
    const c = summariseParityDay([exec('e1'), exec('e2')], RULES)
    expect(await countsHash(a)).toBe(await countsHash(b))
    expect(await countsHash(a)).not.toBe(await countsHash(c))
    expect(await countsHash(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(await countsHash({ ...a, unmeasured: [...a.unmeasured, 'nothing that counts'] })).toBe(await countsHash(a))
  })
})

describe('productionReadDeps.listExecutions', () => {
  /**
   * A workflow_executions double that behaves like PostgREST: whatever `.limit`
   * asks for, one answer holds at most PAGE_SIZE rows, and only `.range` moves
   * the window. On 2026-09-23 the first Stage A refresh listed 1,000 of the
   * 3,500 executions in each three hour window and recorded the day as 3,514
   * unpaired executions and zero agreements (#1497).
   */
  function cappedSupabase(total: number) {
    const rows = Array.from({ length: total }, (_, i) => ({ id: `e${String(i).padStart(5, '0')}`, started_at: new Date(Date.UTC(2027, 8, 20, 13, 0, i)).toISOString() }))
    const ranges: Array<[number, number]> = []
    const orders: string[] = []
    let limit: number | null = null
    let range: [number, number] | null = null
    const builder: Record<string, unknown> = {}
    const chain = () => builder
    for (const m of ['select', 'eq', 'gte', 'lt']) builder[m] = chain
    builder.order = (col: string) => { orders.push(col); return builder }
    builder.limit = (n: number) => { limit = n; return builder }
    builder.range = (from: number, to: number) => { range = [from, to]; ranges.push([from, to]); return builder }
    builder.then = (resolve: (v: unknown) => void) => {
      const [from, to] = range ?? [0, Math.min(limit ?? PAGE_SIZE, PAGE_SIZE) - 1]
      const page = rows.slice(from, Math.min(to, from + PAGE_SIZE - 1) + 1)
      range = null
      limit = null
      resolve({ data: page, error: null })
    }
    const supabase = { from: (table: string) => { if (table !== 'workflow_executions') throw new Error(`unexpected table ${table}`); return builder } } as unknown as SupabaseClient
    return { supabase, ranges, orders, rows }
  }

  it('lists every execution of a window that holds more than one page, in order, one page at a time', async () => {
    const fake = cappedSupabase(2_500)
    const listed = await productionReadDeps(fake.supabase).listExecutions('wf', '2027-09-20T13:00:00.000Z', '2027-09-20T16:00:00.000Z')
    expect(listed).toHaveLength(2_500)
    expect(listed.map((e) => e.id)).toEqual(fake.rows.map((r) => r.id))
    expect(fake.ranges.length).toBeGreaterThanOrEqual(3)
    for (const [from, to] of fake.ranges) expect(to - from + 1).toBeLessThanOrEqual(PAGE_SIZE)
  })

  it('orders each page by a stable key with a unique tiebreaker, so offset paging cannot skip or repeat an execution', async () => {
    const fake = cappedSupabase(5)
    await productionReadDeps(fake.supabase).listExecutions('wf', '2027-09-20T13:00:00.000Z', '2027-09-20T16:00:00.000Z')
    expect(fake.orders[0]).toBe('started_at')
    expect(fake.orders).toContain('id')
  })
})

describe('refreshableDays', () => {
  it('is today and yesterday, whatever the retention window, because a finished day is re-read once and older rows stand (#1497)', () => {
    // 2027-09-20 15:30 UTC is the afternoon of 2027-09-20 Eastern.
    expect(refreshableDays(Date.parse(T0), RETENTION_DAYS)).toEqual(['2027-09-20', '2027-09-19'])
    expect(refreshableDays(Date.parse(T0), 30)).toEqual(['2027-09-20', '2027-09-19'])
  })
})

describe('readParityDay skips windows the node never ran in', () => {
  it('asks for the node row count first and lists executions only where it is above zero, so a day before the node was placed costs eight counts and nothing else', async () => {
    const listed: string[] = []
    const counted: string[] = []
    const executions = await readParityDay(
      {
        countNodeRows: async (_wf, fromIso) => { counted.push(fromIso); return fromIso.startsWith('2027-09-20T13') ? 3 : 0 },
        listExecutions: async (_wf, fromIso) => { listed.push(fromIso); return [{ id: 'e1', started_at: fromIso }] },
        readRows: async (ids) => ids.flatMap((id) => [
          { execution_id: id, step_type: 'buyer_select', step_namespace: 'sell_off', output: exec(id).node, duration_ms: 120 },
          { execution_id: id, step_type: 'code', step_namespace: INCUMBENT_NAMESPACE, output: exec(id).incumbent, duration_ms: 900 },
        ]),
      },
      'wf',
      '2027-09-20',
    )
    expect(counted).toHaveLength(8)
    expect(listed).toEqual(['2027-09-20T13:00:00.000Z'])
    expect(executions).toHaveLength(1)
  })
})
