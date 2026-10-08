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

  /**
   * #1533: the Stage A exit criteria ask for a non zero count of EACH of the four
   * cap refusals, and the budget refusals sit beside them; until now those were
   * hand queries. Counted per considered buyer, because a cap refuses a buyer,
   * not a lead; a node that ran out of time before it considered anyone is
   * counted once from its own reason.
   */
  it('counts every refusal the node recorded, by reason, per considered buyer, and reports zero for a reason it never saw', () => {
    const deferred = (reason: string, considered: Array<{ outcome: string; reason?: string }>) =>
      ({ _route: 'deferred', reason, mode_effective: 'decide_only', lead_state: 'TX', considered })
    const counts = summariseParityDay([
      exec('e1', { node: deferred('hourly_spend_cap', [{ outcome: 'skipped', reason: 'hourly_spend_cap' }]) }),
      exec('e2', { node: deferred('hourly_spend_cap', [{ outcome: 'skipped', reason: 'hourly_spend_cap' }]) }),
      exec('e3', { node: deferred('daily_lead_cap', [{ outcome: 'skipped', reason: 'hourly_lead_cap' }, { outcome: 'skipped', reason: 'daily_lead_cap' }]) }),
      exec('e4', { node: deferred('cap_check_error', [{ outcome: 'skipped', reason: 'cap_check_error' }]) }),
      exec('e5', { node: deferred('rehearsal_deadline', [{ outcome: 'not_reached', reason: 'rehearsal_deadline' }]) }),
      // Out of time before any buyer was considered: the node's own reason is the refusal.
      exec('e6', { node: deferred('rehearsal_deadline', []) }),
      // A rehearsal that went through is not a refusal, and neither is a lead not for sale.
      exec('e7', { node: deferred('decide_only', [{ outcome: 'rehearsed' }]) }),
      exec('e8', { node: { _route: 'not_applicable', reason: 'bid_not_positive', mode_effective: 'decide_only' }, incumbent: { skipped: true, qualified: null, resultCode: null } }),
      // Unpaired executions still count their refusals: the refusal is the node's own fact.
      exec('e9', { node: deferred('breaker_unreadable', [{ outcome: 'skipped', reason: 'breaker_unreadable' }]), incumbent: null }),
    ], RULES)
    expect(counts.refusal_counts).toEqual({
      hourly_lead_cap: 1, daily_lead_cap: 1, hourly_spend_cap: 2, daily_spend_cap: 0,
      rehearsal_deadline: 2, object_deadline: 0, cap_check_error: 1, breaker_unreadable: 1, circuit_open: 0,
    })
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

  /**
   * #1540: an incumbent answer nobody could read (a timeout, a proxy 5xx, a
   * firewall page, a 200 with no result code) is not a decline. Counting it as
   * declined_by_buyer would score the node's classifier against a "no" Tripoint
   * never gave, so it has its own bucket. The script names it since #1540; an
   * older incumbent row is read from the fields it carried (no code, no known
   * 502 flag), so a day already recorded moves its count here when refreshed.
   */
  describe('an incumbent answer that is unknown has its own bucket (#1540)', () => {
    const unknownIncumbent = (debug: { httpStatus?: unknown; rawText?: unknown } | undefined, over: Record<string, unknown> = {}) =>
      ({ skipped: false, qualified: false, resultCode: null, tripoint_answer: 'unknown', ...(debug ? { debug } : {}), ...over })

    it('a 504, a timeout and an HTML 403 are counted as unknown, never as a decline agreed or disputed', () => {
      const counts = summariseParityDay([
        exec('e504', { incumbent: unknownIncumbent({ httpStatus: 504, rawText: 'gateway timeout' }, { unknown_reason: 'http_504' }) }),
        exec('eTimeout', { incumbent: unknownIncumbent({ httpStatus: null, rawText: null }, { unknown_reason: 'timeout' }) }),
        exec('e403', { incumbent: unknownIncumbent({ httpStatus: 403, rawText: '<!DOCTYPE html><html>blocked</html>' }, { unknown_reason: 'http_403' }) }),
      ], RULES)
      expect(counts.incumbent_unknown_count).toBe(3)
      expect(counts).toMatchObject({ classification_agree: 0, classification_disagree: 0, outcome_unknown_count: 0 })
      expect(counts.disagreement_execution_ids).toEqual([])
      // The timeout is measured, as unknown: it is not a missing response.
      expect(counts.unmeasured.some((u) => u.startsWith('classification:'))).toBe(false)
    })

    it('reads an older incumbent row with no code and no 502 flag as unknown, so recorded days shift their count here', () => {
      const counts = summariseParityDay([
        exec('eOld', { incumbent: { skipped: false, qualified: false, resultCode: null, debug: { httpStatus: 403, rawText: '<html>blocked</html>' } } }),
        // The two known 502 answers of the older script are not unknown.
        exec('eInvalid', { incumbent: { skipped: false, qualified: false, resultCode: null, tripointLeadRejected: true, debug: { httpStatus: 502, rawText: '{"ok":false}' } } }),
      ], RULES)
      expect(counts.incumbent_unknown_count).toBe(1)
    })

    it('when the classifier reaches a verdict the incumbent could not, that is a disagreement naming the execution', () => {
      // A 409 carrying a duplicate code: the incumbent script calls a non 2xx unknown, the rules decline it.
      const counts = summariseParityDay([
        exec('e409', { incumbent: unknownIncumbent({ httpStatus: 409, rawText: '{"ok":true,"data":{"createLead":{"resultCode":1003}}}' }) }),
      ], RULES)
      expect(counts.incumbent_unknown_count).toBe(1)
      expect(counts.classification_disagree).toBe(1)
      expect(counts.disagreement_execution_ids).toEqual(['e409'])
    })

    it('a known answer is compared exactly as before', () => {
      const declinedBody = '{"ok":true,"data":{"createLead":{"resultCode":1003}}}'
      const counts = summariseParityDay([
        exec('e1', { incumbent: { skipped: false, qualified: true, resultCode: 1000, tripoint_answer: 'accepted', debug: { httpStatus: 200, rawText: '{"ok":true,"data":{"createLead":{"resultCode":1000,"id":"L-1"}}}' } } }),
        exec('e2', { incumbent: { skipped: false, qualified: false, resultCode: 1003, tripoint_answer: 'declined', debug: { httpStatus: 200, rawText: declinedBody } } }),
      ], RULES)
      expect(counts).toMatchObject({ incumbent_unknown_count: 0, classification_agree: 2, classification_disagree: 0 })
    })

    it('is a count the hash covers, so a moved unknown count clears a sign off', async () => {
      const a = summariseParityDay([exec('e1')], RULES)
      expect(a.incumbent_unknown_count).toBe(0)
      expect(await countsHash({ ...a, incumbent_unknown_count: 1 })).not.toBe(await countsHash(a))
    })
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
    expect(older.unmeasured).toContain('state:1 rehearsed execution with no recorded state')
  })

  it('a lead the node never rehearsed has no state to record, so it counts toward nothing about state and earns no unmeasured note (#1507)', () => {
    const counts = summariseParityDay([
      exec('e1'),
      exec('e2', { node: { _route: 'not_applicable', reason: 'sell_off_false', mode_effective: 'decide_only' }, incumbent: { skipped: true, qualified: null, resultCode: null } }),
      exec('e3', { node: { _route: 'not_applicable', reason: 'bid_not_positive', mode_effective: 'decide_only' }, incumbent: { skipped: true, qualified: null, resultCode: null } }),
    ], RULES)
    expect(counts).toMatchObject({ state_resolved: 1, state_unresolved: 0 })
    expect(counts.unmeasured.some((u) => u.startsWith('state:'))).toBe(false)
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

  it('measures the latency over the rows that rehearsed only: a lead the node decided was not for sale took no time and must not drown the median (#1506)', () => {
    const notForSale = (id: string) => exec(id, {
      node: { _route: 'not_applicable', reason: 'sell_off_false', mode_effective: 'decide_only' },
      node_duration_ms: 0,
      incumbent: { skipped: true, qualified: null, resultCode: null },
    })
    const rehearsed = [500, 600, 700].map((ms, i) => exec(`r${i}`, { node_duration_ms: ms }))
    const counts = summariseParityDay([...rehearsed, ...Array.from({ length: 20 }, (_, i) => notForSale(`n${i}`))], RULES)
    expect(counts.decide_only_latency_p50_ms).toBe(600)
    expect(counts.decide_only_latency_p95_ms).toBe(700)
    const onlyNotForSale = summariseParityDay(Array.from({ length: 5 }, (_, i) => notForSale(`n${i}`)), RULES)
    expect(onlyNotForSale.decide_only_latency_p50_ms).toBeNull()
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
        nodeRanIn: async () => true,
        // The ET day 2027-09-20 starts at 04:00Z and is read in three hour windows; the 13:00Z window holds the one execution.
        listExecutions: async (_wf, fromIso) => (fromIso.startsWith('2027-09-20T13') ? [{ id: 'e1', started_at: fromIso }] : []),
        readRows: async (ids) => ids.flatMap((id) => [
          { execution_id: id, step_type: 'buyer_select', step_namespace: 'sell_off', output: exec(id).node, duration_ms: 120 },
          { execution_id: id, step_type: 'code', step_namespace: INCUMBENT_NAMESPACE, output: exec(id).incumbent, duration_ms: 900 },
        ]),
      },
      bids: { earliestBidRowIso: async () => '2027-09-01T00:00:00.000Z', listBidExecutions: async () => ['e1'] },
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
    expect(today).toMatchObject({ workflow_id: 'wf-engine', organization_id: 'org-1', sell_off_agree: 1, hash_match: 1, classification_agree: 1, incumbent_unknown_count: 0, window_complete: false })
    expect(today?.counts_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(today?.refusal_counts).toMatchObject({ hourly_lead_cap: 0, daily_lead_cap: 0, hourly_spend_cap: 0, daily_spend_cap: 0 })
    expect(Object.keys(today ?? {})).not.toContain('signed_off_at')
    const yesterday = upserts.find((r) => r.et_day === '2027-09-19')
    expect(yesterday).toMatchObject({ sell_off_agree: 0, window_complete: true })
  })

  it('a day whose reads fail is reported by name and the other days are still written (L98)', async () => {
    const { deps, upserts } = refreshDeps({
      read: {
        nodeRanIn: async () => true,
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
        nodeRanIn: async () => true,
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

describe('the Stage B figures on each row (#1809)', () => {
  const NOW = Date.parse(T0)
  const WF = { id: 'wf-engine', organization_id: 'org-1' }
  const base = (over: Partial<RefreshDeps> = {}): { deps: RefreshDeps; upserts: ParityRowWrite[] } => {
    const upserts: ParityRowWrite[] = []
    return {
      upserts,
      deps: {
        listWorkflows: async () => [WF],
        rules: async () => RULES,
        read: {
          nodeRanIn: async () => true,
          listExecutions: async (_wf, fromIso) => (fromIso.startsWith('2027-09-20T13') ? [{ id: 'e1', started_at: '2027-09-20T13:10:00.000Z' }] : []),
          readRows: async (ids) => ids.flatMap((id) => [
            { execution_id: id, step_type: 'buyer_select', step_namespace: 'sell_off', output: { ...exec(id).node, mode_effective: 'live', reason: 'canary_out' }, duration_ms: 0 },
            { execution_id: id, step_type: 'code', step_namespace: INCUMBENT_NAMESPACE, output: exec(id).incumbent, duration_ms: 2750 },
          ]),
        },
        bids: { earliestBidRowIso: async () => '2027-09-01T00:00:00.000Z', listBidExecutions: async () => ['e1'] },
        upsert: async (row) => { upserts.push(row); return row },
        now: () => NOW,
        retentionDays: RETENTION_DAYS,
        localDev: false,
        log: () => {},
        ...over,
      },
    }
  }

  it('writes the Stage B report beside the counts, outside the counts hash so it cannot clear a sign off', async () => {
    const { deps, upserts } = base()
    await runParityRefresh(deps)
    const today = upserts.find((r) => r.et_day === '2027-09-20')
    expect(today?.stage_b).toMatchObject({ legacy: { attempts: 1, accepted: 1, duration_p50_ms: 2750 }, canary: { attempts: 0 }, bid_rows: { legacy_missing: 0, legacy_multiple: 0 } })
    const { stage_b: _b, workflow_id: _w, et_day: _d, organization_id: _o, window_complete: _c, counts_hash, ...counts } = today as ParityRowWrite
    expect(counts_hash).toBe(await countsHash(counts))
  })

  it('a bid read that fails leaves the row written, with only the bid check unmeasured and the reason named (L73)', async () => {
    const { deps, upserts } = base({ bids: { earliestBidRowIso: async () => { throw new Error('lead_sighting_bids: statement timeout') }, listBidExecutions: async () => [] } })
    const summary = await runParityRefresh(deps)
    expect(summary.errors).toEqual([])
    const today = upserts.find((r) => r.et_day === '2027-09-20')
    expect(today?.stage_b?.bid_rows).toEqual({ unmeasured: expect.stringMatching(/statement timeout/) })
    expect(today?.stage_b?.legacy.attempts).toBe(1)
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
    // A refusal count is a count: moving one clears a sign off like any other (#1533).
    expect(await countsHash({ ...a, refusal_counts: { ...a.refusal_counts, daily_lead_cap: a.refusal_counts.daily_lead_cap + 1 } })).not.toBe(await countsHash(a))
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
  it('asks whether the node ran first and lists executions only where it did, so a day before the node was placed costs eight probes and nothing else', async () => {
    const listed: string[] = []
    const counted: string[] = []
    const executions = await readParityDay(
      {
        nodeRanIn: async (_wf, fromIso) => { counted.push(fromIso); return fromIso.startsWith('2027-09-20T13') },
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
    // The legacy step's own duration is kept for the Stage B latency comparison (#1809).
    expect(executions[0].incumbent_duration_ms).toBe(900)
  })
})

describe('productionReadDeps.nodeRanIn (#1884)', () => {
  /**
   * The question readParityDay asks of a window is only whether the node ran
   * there at all. It used to be answered with an exact COUNT, which visits every
   * execution_steps row of the three hour window: about 94 MB read from disk per
   * call, 16 calls an hour, 514 GB between 2026-09-24 and 2026-10-08, the second
   * largest reader on the database. One row answers the same question, and
   * ordered by execution_started_at the scan walks the window's own index and
   * stops at the first match (measured on production 2026-10-08: 94 buffers
   * touched, against about 30,000 for the count).
   */
  function probeSupabase(answer: { data: unknown; error: { message: string } | null }) {
    const calls: {
      table?: string
      select?: unknown[]
      eq: Array<[string, unknown]>
      gte: Array<[string, unknown]>
      lt: Array<[string, unknown]>
      order: Array<[string, unknown]>
      limit?: number
    } = { eq: [], gte: [], lt: [], order: [] }
    const builder: Record<string, unknown> = {}
    builder.select = (...args: unknown[]) => { calls.select = args; return builder }
    builder.eq = (c: string, v: unknown) => { calls.eq.push([c, v]); return builder }
    builder.gte = (c: string, v: unknown) => { calls.gte.push([c, v]); return builder }
    builder.lt = (c: string, v: unknown) => { calls.lt.push([c, v]); return builder }
    builder.order = (c: string, o: unknown) => { calls.order.push([c, o]); return builder }
    builder.limit = (n: number) => { calls.limit = n; return builder }
    builder.then = (resolve: (v: unknown) => void) => resolve(answer)
    const supabase = { from: (table: string) => { calls.table = table; return builder } } as unknown as SupabaseClient
    return { supabase, calls }
  }
  const FROM = '2027-09-20T13:00:00.000Z'
  const TO = '2027-09-20T16:00:00.000Z'

  it('asks for one row, never a count, ordered so the window index answers it', async () => {
    const fake = probeSupabase({ data: [{ execution_id: 'e1' }], error: null })
    expect(await productionReadDeps(fake.supabase).nodeRanIn('wf', FROM, TO)).toBe(true)
    expect(fake.calls.table).toBe('execution_steps')
    // No second argument: a { count } option is the whole window scan this replaces.
    expect(fake.calls.select).toEqual(['execution_id'])
    expect(fake.calls.limit).toBe(1)
    expect(fake.calls.order[0]?.[0]).toBe('execution_started_at')
    expect(fake.calls.eq).toEqual(expect.arrayContaining([['workflow_id', 'wf'], ['step_type', 'buyer_select']]))
    expect(fake.calls.gte).toEqual([['execution_started_at', FROM]])
    expect(fake.calls.lt).toEqual([['execution_started_at', TO]])
  })

  it('answers no when the window holds no node row', async () => {
    const fake = probeSupabase({ data: [], error: null })
    expect(await productionReadDeps(fake.supabase).nodeRanIn('wf', FROM, TO)).toBe(false)
  })

  it('reads the window when the answer is missing, because an unanswered question is not zero rows (L215)', async () => {
    const fake = probeSupabase({ data: null, error: null })
    expect(await productionReadDeps(fake.supabase).nodeRanIn('wf', FROM, TO)).toBe(true)
  })

  it('throws a read failure rather than skipping the window', async () => {
    const fake = probeSupabase({ data: null, error: { message: 'canceling statement due to statement timeout' } })
    await expect(productionReadDeps(fake.supabase).nodeRanIn('wf', FROM, TO)).rejects.toThrow(
      /execution_steps probe: canceling statement due to statement timeout/,
    )
  })
})
