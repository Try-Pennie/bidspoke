import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { waitAtMost } from '../wait-at-most'
import {
  OUTAGE_DRILL_TIMEOUT_MS,
  OUTAGE_SHAPES,
  applyExemptions,
  compareOutage,
  decisionsFrom,
  firstStepOutputDifference,
  lateAnswer,
  HUNG_ANSWER_ALLOWANCE_MS,
  isLastGoodKey,
  ownExecutionId,
  isOutageNetworkRejection,
  outageNetwork,
  type OutageRecord,
  type OutageExemption,
} from '../outage'

/**
 * The pure parts of the outage drill (#1305): the shapes a failing database
 * takes, which KV keys are stored copies, decisions read from the engine's own
 * step records, the comparison of a database-down run with its database-up
 * twin, and the exemptions for flows that do not pass yet.
 */

describe('outageNetwork', () => {
  it.each(OUTAGE_SHAPES)('answers every request in the %s shape and counts it', async (shape) => {
    const net = outageNetwork(shape)
    const giveUp = new AbortController()
    const call = net.fetch('https://supabase-url.placeholder.invalid/rest/v1/workflows?id=eq.1', { method: 'GET', signal: giveUp.signal })
    if (shape === 'hung') {
      giveUp.abort()
      await expect(call).rejects.toMatchObject({ name: 'AbortError' })
    } else if (shape === 'refused') {
      await expect(call).rejects.toThrow(TypeError)
    } else {
      const res = await call
      expect(res.status).toBeGreaterThanOrEqual(500)
    }
    expect(net.requests()).toBe(1)
  })

  // #1851: a database that never answers. Only the caller giving up ends a request.
  it('never answers in the hung shape until the caller gives up', async () => {
    let settled = false
    void outageNetwork('hung').fetch('https://x/rest/v1/t', {}).then(() => { settled = true }, () => { settled = true })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 5))
    expect(settled).toBe(false)
  })

  it('gives up at once in the hung shape when the signal was already aborted', async () => {
    await expect(outageNetwork('hung').fetch('https://x/rest/v1/t', { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('answers the 503 shape the way PostgREST does when it cannot reach Postgres', async () => {
    const res = await outageNetwork('unavailable_503').fetch('https://x/rest/v1/t', {})
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('retry-after')).not.toBeNull()
    expect(((await res.json()) as { code: string }).code).toBe('PGRST002')
  })

  it('answers the gateway shape with an HTML page, as Cloudflare does in front of Supabase', async () => {
    const res = await outageNetwork('gateway_html_522').fetch('https://x/rest/v1/t', {})
    expect(res.status).toBe(522)
    expect(res.headers.get('content-type')).toContain('text/html')
  })
})

describe('isLastGoodKey', () => {
  it.each([
    'ep-lastgood:engine:/bidding',
    'partner-lastgood:58d50fe7-3e86-4d71-85c7-4533ab08acb0',
    'env-vars-org-1-lastgood',
    'env-vars-org-1-workflow-scoped-lastgood',
    'partner-constants-v2-org-1-lastgood',
    'buyer-profiles:org-1:lastgood',
    'workflow-def-lastgood:wf-1',
    'slack-conns-lastgood',
  ])('keeps %s', (key) => {
    expect(isLastGoodKey(key)).toBe(true)
  })

  it.each([
    'ep:engine:/bidding',
    'workflow-def-wf-1',
    'env-vars-org-1',
    'env-vars-org-1-workflow-scoped',
    'partner-constants-v2-org-1',
    'buyer-profiles:org-1',
    'buyer-profiles:org-1:saved_at',
    'sf-token-org-1',
  ])('drops the fast cache key %s', (key) => {
    expect(isLastGoodKey(key)).toBe(false)
  })
})

describe('decisionsFrom', () => {
  it('reads routes, the nodes run and the final node from the step records, in step order', () => {
    const d = decisionsFrom([
      { step_order: 2, step_namespace: 'b', step_node_id: 'nb', step_type: 'branch', output: { _route: 'yes' } },
      { step_order: 1, step_namespace: 'a', step_node_id: 'na', step_type: 'code', output: { x: 1 } },
    ])
    expect(d.nodes_executed).toEqual(['a', 'b'])
    expect(d.routes).toEqual([{ node: 'nb', namespace: 'b', type: 'branch', route: 'yes' }])
    expect(d.final_node).toBe('b')
  })

  it('breaks a tie in step order by namespace, as parallel children share one', () => {
    const d = decisionsFrom([
      { step_order: 1, step_namespace: 'z', step_node_id: 'z', step_type: 'code', output: null },
      { step_order: 1, step_namespace: 'm', step_node_id: 'm', step_type: 'code', output: null },
    ])
    expect(d.nodes_executed).toEqual(['m', 'z'])
  })
})

const base: OutageRecord = {
  response: { status: 200, body: { ok: true } },
  outbound: [{ via: 'engine', method: 'POST', host: 'tripoint-proxy.trypennie.dev', path: '/leads/create', body: { a: 1 } }],
  code_dispatch: [{ binding: 'DYNAMIC_WORKER_LOADER', name: 'bs-1', path: '/execute/x', namespaces: ['x'] }],
  decisions: { routes: [{ node: 'n', namespace: 'b', type: 'branch', route: 'yes' }], nodes_executed: ['a', 'b'], final_node: 'b' },
  do_state: { CAPS: { id1: { count: 1 } } },
  error: undefined,
}

describe('ownExecutionId', () => {
  const step = (execution_id?: string) => ({ step_order: 1, step_namespace: 'a', step_type: 'code', output: null, execution_id })
  it('reads the one execution id every step of the run carries', () => {
    expect(ownExecutionId([step('e1'), step('e1')])).toBe('e1')
  })
  // Masking the wrong id could hide a real difference, so an ambiguous log masks nothing.
  it('is undefined when the steps carry none, or more than one', () => {
    expect(ownExecutionId([])).toBeUndefined()
    expect(ownExecutionId([step()])).toBeUndefined()
    expect(ownExecutionId([step('e1'), step('e2')])).toBeUndefined()
  })
})

describe('compareOutage', () => {
  it('finds nothing when the down run decided and sent exactly what its twin did', () => {
    expect(compareOutage(base, structuredClone(base))).toEqual([])
  })

  it.each([
    ['response', { ...base, response: { status: 503, body: { error: 'down' } } }],
    ['outbound', { ...base, outbound: [] }],
    ['code_dispatch', { ...base, code_dispatch: [] }],
    ['routes', { ...base, decisions: { ...base.decisions, routes: [] } }],
    ['nodes_executed', { ...base, decisions: { ...base.decisions, nodes_executed: ['a'] } }],
    ['final_node', { ...base, decisions: { ...base.decisions, final_node: 'a' } }],
    ['do_state', { ...base, do_state: {} }],
    ['error', { ...base, error: 'Error: Failed to load workflow' }],
  ] as const)('names a difference in %s', (field, down) => {
    const diffs = compareOutage(base, down as OutageRecord)
    expect(diffs.map((d) => d.field)).toContain(field)
  })

  // An outage is expected to raise alerts its twin does not, and since #1881 the
  // outcome dead letter takes its cooldown on the AlertClaim object. Who may post
  // an alert decides no money, so its state is not a difference; every other
  // object's still is.
  it('does not count an alert claim taken only in the down run as a difference', () => {
    const down = { ...base, do_state: { ...base.do_state, ALERT_CLAIM: { abc: { alarm: 1790868600000, kv: { data: { claimed_until: 1 } }, tables: {} } } } }
    const up = { ...base, do_state: { ...base.do_state, ALERT_CLAIM: {} } }
    expect(compareOutage(up, down)).toEqual([])
  })

  it('still counts any other Durable Object beside the alert claims', () => {
    const down = { ...base, do_state: { CAPS: { id1: { count: 2 } }, ALERT_CLAIM: { abc: {} } } }
    expect(compareOutage(base, down).map((d) => d.field)).toEqual(['do_state'])
  })

  it('orders outbound requests before comparing, since parallel calls land in either order', () => {
    const two = { ...base, outbound: [base.outbound[0], { ...base.outbound[0], host: 'am-one-proxy.trypennie.dev' }] }
    const swapped = { ...two, outbound: [two.outbound[1], two.outbound[0]] }
    expect(compareOutage(two, swapped)).toEqual([])
  })

  // The run's own execution id is minted fresh from the drill's pinned RNG, so a
  // correct outage path that draws from it (the outcome dead letter firing when a
  // write aborts rather than hangs, #1484) shifts the id in a `?execution=` link.
  // Only that link's value is normalised.
  it('does not count an outbound that differs only by the per-run execution link id', () => {
    const link = (id: string) => ({ ...base.outbound[0], body: { url: `https://app/workflows/w?execution=${id}` } })
    const up = { ...base, outbound: [link('01a0f7fa-bd80-7780-ae45-9057801d3651')] }
    const down = { ...base, outbound: [link('01a0f7fa-bd80-7606-aea2-b53569c3b6c9')] }
    expect(compareOutage(up, down)).toEqual([])
  })

  it('still counts a down run that sent to a DIFFERENT partner, buyer or workflow uuid', () => {
    // Those ids are references, not per-run mints: a different one is a real money
    // difference and normalising the execution link must NOT hide it.
    const up = { ...base, outbound: [{ ...base.outbound[0], body: { partner_id: '11111111-1111-4111-8111-111111111111' } }] }
    const down = { ...base, outbound: [{ ...base.outbound[0], body: { partner_id: '22222222-2222-4222-8222-222222222222' } }] }
    expect(compareOutage(up, down).map((d) => d.field)).toContain('outbound')
  })

  it('still counts a real field difference that rides alongside a shifted execution link', () => {
    const b = (bid: number, id: string) => ({ ...base.outbound[0], body: { bid_cents: bid, url: `https://app/w?execution=${id}` } })
    const up = { ...base, outbound: [b(25000, '01a0f7fa-bd80-7780-ae45-9057801d3651')] }
    const down = { ...base, outbound: [b(19000, '01a0f7fa-bd80-7606-aea2-b53569c3b6c9')] }
    expect(compareOutage(up, down).map((d) => d.field)).toContain('outbound')
  })

  // #2009: the id is minted after the definition load, which under a hung
  // database races its deadline, so a slow runner draws a different number of
  // random values first and the run's OWN id shifts. Salesforce bodies and the
  // buyer ledger carry it as a plain field, not only in a link, so each run's own
  // id (read from its own step log) is masked wherever it appears.
  const UP_ID = '01a0f7fa-bd80-7ac7-91de-300d2210bcd4'
  const DOWN_ID = '01a0f7fa-bd80-714b-a47f-b4ee256c769c'
  const sf = (id: string) => ({ ...base.outbound[0], body: { executionId: id, Credit_Pull_Result_ES__c: 'Fail' } })

  it('does not count a body field carrying each run\'s own execution id', () => {
    const up = { ...base, execution_id: UP_ID, outbound: [sf(UP_ID)] }
    const down = { ...base, execution_id: DOWN_ID, outbound: [sf(DOWN_ID)] }
    expect(compareOutage(up, down)).toEqual([])
  })

  it('does not count Durable Object state carrying each run\'s own execution id', () => {
    const ledger = (id: string) => ({ BUYER_LEDGER: { k: { tables: { entries: [JSON.stringify({ execution_id: id, payout_cents: 2500 })] } } } })
    expect(compareOutage({ ...base, execution_id: UP_ID, do_state: ledger(UP_ID) }, { ...base, execution_id: DOWN_ID, do_state: ledger(DOWN_ID) })).toEqual([])
  })

  it('still counts a down run that carried an id other than its own', () => {
    const up = { ...base, execution_id: UP_ID, outbound: [sf(UP_ID)] }
    const down = { ...base, execution_id: DOWN_ID, outbound: [sf('01a0f7fa-bd80-7000-8000-000000000000')] }
    expect(compareOutage(up, down).map((d) => d.field)).toEqual(['outbound'])
  })

  it('masks nothing when a run recorded no execution id', () => {
    const up = { ...base, outbound: [sf(UP_ID)] }
    const down = { ...base, outbound: [sf(DOWN_ID)] }
    expect(compareOutage(up, down).map((d) => d.field)).toEqual(['outbound'])
  })

  // A value that differs late was shown cut at its start, so the report could not
  // say where the twins parted (the 2026-10-14 do_state mismatches).
  it('shows a long value around where the two runs part, not from its start', () => {
    const big = (tail: string) => ({ CAPS: { k: { pad: 'x'.repeat(600), tail } } })
    const diff = compareOutage({ ...base, do_state: big('sold') }, { ...base, do_state: big('held') }).find((d) => d.field === 'do_state')!
    expect(diff.detail).toMatch(/"tail":"sold"/)
    expect(diff.detail).toMatch(/"tail":"held"/)
  })

  // A long list differing late would be cut off before the difference, so a
  // list's detail names the first position where the two runs part (L445).
  it('names the first position where two lists part, however long they are', () => {
    const long = Array.from({ length: 40 }, (_, i) => `step_${i}`)
    const down = { ...base, decisions: { ...base.decisions, nodes_executed: [...long.slice(0, 33), 'refuse_by_name'] } }
    const diff = compareOutage({ ...base, decisions: { ...base.decisions, nodes_executed: long } }, down).find((d) => d.field === 'nodes_executed')!
    expect(diff.detail).toMatch(/^at \[33\]: up "step_33"; down "refuse_by_name"/)
    expect(diff.detail).toMatch(/up has 40, down has 34/)
  })

  it('puts the error first, so it is what an exemption keys on', () => {
    const diffs = compareOutage(base, { ...base, error: 'Error: Failed to load workflow', response: { status: 0, body: null } })
    expect(diffs[0].field).toBe('error')
  })
})

describe('applyExemptions', () => {
  const today = '2026-10-07'
  const diff = (field: string, detail: string) => ({ field, detail })
  const ex = (over: Partial<OutageExemption> = {}): OutageExemption => ({
    workflow: 'Engine Bidding Workflow', shape: 'refused', first_difference: 'error: *Failed to load workflow*', issue: 1845, expires: '2026-10-31', ...over,
  })

  it('excuses a fixture whose first difference matches an entry', () => {
    const r = applyExemptions([{ workflow: 'Engine Bidding Workflow', variant: 'v', shape: 'refused', diffs: [diff('error', 'Error: Failed to load workflow wf-1')] }], [ex()], today)
    expect(r.failures).toEqual([])
    expect(r.excused).toHaveLength(1)
  })

  it('fails a difference no entry covers, naming the fixture and the field', () => {
    const r = applyExemptions([{ workflow: 'Main Flow', variant: 'v', shape: 'refused', diffs: [diff('outbound', 'missing POST x')] }], [], today)
    expect(r.failures[0]).toMatch(/Main Flow.*refused.*outbound/)
  })

  it('does not excuse a different first difference in an exempted flow', () => {
    const r = applyExemptions([{ workflow: 'Engine Bidding Workflow', variant: 'v', shape: 'refused', diffs: [diff('outbound', 'missing POST x')] }], [ex()], today)
    expect(r.failures).toHaveLength(2)
    expect(r.failures.join('\n')).toMatch(/matched no difference/)
  })

  it('fails an entry past its expiry date, even when it still matches', () => {
    const r = applyExemptions([{ workflow: 'Engine Bidding Workflow', variant: 'v', shape: 'refused', diffs: [diff('error', 'Error: Failed to load workflow wf-1')] }], [ex({ expires: '2026-10-06' })], today)
    expect(r.failures.join('\n')).toMatch(/expired/)
  })

  it('prefers a live entry over an expired one for the same difference, whatever their order', () => {
    const f = { workflow: 'Engine Bidding Workflow', variant: 'v', shape: 'refused' as const, diffs: [diff('error', 'Error: Failed to load workflow wf-1')] }
    const r = applyExemptions([f], [ex({ expires: '2026-10-06' }), ex()], today)
    expect(r.excused).toHaveLength(1)
    expect(r.failures.join('\n')).not.toMatch(/expired on/)
  })

  it('fails an entry that matched nothing, so a fixed flow cannot stay exempt', () => {
    const r = applyExemptions([], [ex()], today)
    expect(r.failures.join('\n')).toMatch(/matched no difference.*#1845/)
  })
})

/**
 * workerd reports a rejected fetch as unhandled even when supabase-js catches it
 * and the caller awaits the result (reproduced 2026-10-07 with one awaited read,
 * outside the engine), so every read the refused shape fails would fail the run.
 * Only that rejection is ignored; any other unhandled error still fails it.
 */
describe('isOutageNetworkRejection', () => {
  it('recognises the refused shape rejecting a request', async () => {
    const err = await outageNetwork('refused').fetch('https://x/rest/v1/t', {}).catch((e: unknown) => e)
    expect(isOutageNetworkRejection(err)).toBe(true)
  })

  it('recognises the hung shape abandoning a request the caller gave up on', async () => {
    const giveUp = new AbortController()
    const call = outageNetwork('hung').fetch('https://x/rest/v1/t', { signal: giveUp.signal })
    giveUp.abort()
    expect(isOutageNetworkRejection(await call.catch((e: unknown) => e))).toBe(true)
  })

  it('recognises it once serialized, as vitest hands it over', async () => {
    const err = (await outageNetwork('refused').fetch('https://x/rest/v1/t', {}).catch((e: unknown) => e)) as Error
    expect(isOutageNetworkRejection({ name: err.name, message: err.message, stack: err.stack })).toBe(true)
  })

  it.each([
    ['a fetch failure from anywhere else', Object.assign(new TypeError('fetch failed'), { stack: 'TypeError: fetch failed\n    at somewhere (src/engine/index.ts:1:1)' })],
    ['another error from the drill network file', Object.assign(new Error('boom'), { stack: 'Error: boom\n    at fetchImpl (money-gate/lib/outage.ts:34:36)' })],
    ['not an error at all', 'fetch failed'],
    ['nothing', undefined],
  ])('does not recognise %s', (_why, err) => {
    expect(isOutageNetworkRejection(err)).toBe(false)
  })
})

/**
 * Which step first produced a different output, so a down run that took another
 * path names its cause (the attempt that failed), not only where the paths split.
 */
describe('firstStepOutputDifference', () => {
  const step = (ns: string, output: unknown, order = 1) => ({ step_order: order, step_namespace: ns, step_type: 'code', output })

  it('names the first step, in step order, whose output differs', () => {
    const up = [step('a', { x: 1 }, 1), step('bid_race.tripoint', { bid: 22 }, 2), step('bid_race', { _route: 'winner' }, 3)]
    const down = [step('a', { x: 1 }, 1), step('bid_race.tripoint', { skipped: true, reason: 'config_unavailable' }, 2), step('bid_race', { _route: 'no_winner' }, 3)]
    const d = firstStepOutputDifference(up, down)!
    expect(d.namespace).toBe('bid_race.tripoint')
    expect(d.down).toContain('config_unavailable')
  })

  it('names a step only one run reached', () => {
    expect(firstStepOutputDifference([step('a', 1)], [step('a', 1), step('b', 2, 2)])!.namespace).toBe('b')
  })

  it('is null when every step output agrees', () => {
    expect(firstStepOutputDifference([step('a', { x: 1 })], [step('a', { x: 1 })])).toBeNull()
  })
})

/**
 * A hung database must not slow the answer past the lead read budget (#1851).
 * Engine's own timeout is not recorded anywhere; production shows it routinely
 * waits about 10 s (Engine flow p99.9 9.4 s over 7 days, 2026-10-07), so the rule
 * is relative: the down run answers no more than the allowance later than its twin.
 */
describe('lateAnswer', () => {
  it('allows twice the lead read deadline, taken from the constant', async () => {
    const { LEAD_READ_DEADLINE_MS } = await import('../../../src/lib/lead-read-budget')
    expect(HUNG_ANSWER_ALLOWANCE_MS).toBe(2 * LEAD_READ_DEADLINE_MS)
  })

  it('passes an answer within the allowance of its twin', () => {
    expect(lateAnswer(1_000, 1_000 + HUNG_ANSWER_ALLOWANCE_MS)).toBeNull()
  })

  it('names an answer later than the allowance, with both times', () => {
    const d = lateAnswer(1_000, 1_001 + HUNG_ANSWER_ALLOWANCE_MS)!
    expect(d.field).toBe('answer_time')
    expect(d.detail).toMatch(/up answered in 1000 ms; down in 3001 ms/)
  })
})

describe('the drill has room to finish (#1851)', () => {
  const workflowMinutes = (file: string): number => {
    const text = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '.github', 'workflows', file), 'utf8')
    // One job per file, so its one limit is the drill's; a second job would make
    // the first limit found possibly someone else's.
    const all = [...text.matchAll(/timeout-minutes:\s*(\d+)/g)]
    if (all.length !== 1) throw new Error(`${file} names ${all.length} timeout-minutes, not the one drill job's`)
    return Number(all[0][1])
  }

  it('gives the drill well over its measured run time, and ends it inside each job, so a slow run fails with a verdict', () => {
    // Measured 2026-10-07 with the hung shape: 608 s on a laptop; CI ran the
    // three shape drill 5 to 20 percent slower than the same laptop.
    expect(OUTAGE_DRILL_TIMEOUT_MS).toBeGreaterThanOrEqual(1.5 * 608_000 * 1.2)
    for (const file of ['outage-drill.yml', 'outage-drill-weekly.yml']) {
      // Install, build and the report upload need minutes of their own.
      expect(OUTAGE_DRILL_TIMEOUT_MS + 4 * 60_000).toBeLessThanOrEqual(workflowMinutes(file) * 60_000)
    }
  })
})

describe('waiting at most a while for post-response work (#1851)', () => {
  it('returns when the work settles, and when the limit passes first, leaving no timer behind either way', async () => {
    vi.useFakeTimers()
    try {
      await waitAtMost(Promise.resolve(), 250)
      expect(vi.getTimerCount()).toBe(0)
      let done = false
      const hung = waitAtMost(new Promise<void>(() => {}), 250).then(() => { done = true })
      await vi.advanceTimersByTimeAsync(249)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await hung
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears its timer when the work rejects, and passes the rejection on', async () => {
    vi.useFakeTimers()
    try {
      await expect(waitAtMost(Promise.reject(new Error('post-response write failed')), 250)).rejects.toThrow('post-response write failed')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
