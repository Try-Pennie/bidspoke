/**
 * The ported Main Flow, as the transform builds it from the production
 * definition (#2171, #1680 plan points 1, 3, 5, 10 and amendment 3, and the
 * collections post before the answer, #2832).
 *
 * These judge the graph the apply would PUT, by walking it, not by reading the
 * transform's own lists: which writes run on the trades present path is
 * computed from equifax_debt's edges, and the worst case after the answer, and
 * of parallel_1 before it, is computed from each step's own settings with the
 * engine's own retry rules.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findSalesforceConfigProblems, findWorkflowCycle, validateDefinitionReferences, validateWorkflowDef } from '@bidspoke/workflow-definition'
import type { Env } from '../../../index'
import type { NodeDefinition } from '../../../types'
import { CONTINUATION_WINDOW_MS, PostResponseBudget, realClock } from '../../post-response-budget'
import { withRetry } from '../../../engine/retry'
import { buildContext } from '../../../engine/context'
import { executeSalesforceNode } from '../../../engine/nodes/salesforce'
import { executeAchieveOffersNode } from '../../../engine/nodes/achieve-offers'
import { runCanvasScript } from '../../../engine/scripts/__tests__/canvas-script'
import { stubFetch } from '../../../__tests__/helpers/fetch-mock'
import { COLLECTIONS_APEX, COLLECTIONS_APEX_PATH, COLLECTIONS_BODY, COLLECTIONS_SLOT, INQUIRY_APEX_PATH, PORT_STAGES, portMainFlow, type DefNode, type Definition, type PortOptions } from '../transform'
import { nodeByNamespace, productionMainFlow, relayUrls } from './production-fixture'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import GATE_MAIN_FLOW_RAW from '../../../../money-gate/fixtures/definitions/60e2e0bc-5aa2-47db-b333-3a8fe1c62e09.json?raw'

const before = productionMainFlow()
/** Everything the port does: every post native, the inquiry after each write, the collections slot in parallel_1. */
const FULL: PortOptions = { posts: 'all', moveInquiry: true, collections: true }
const ported = portMainFlow(productionMainFlow(), FULL)

const byId = (def: Definition) => new Map(def.nodes.map((n) => [n.id, n]))
const outOf = (def: Definition, id: string) => def.edges.filter((e) => e.source === id)
const into = (def: Definition, id: string) => def.edges.filter((e) => e.target === id)

/** Every node reachable from `startId`, child slots included. */
function reachable(def: Definition, startId: string): Set<string> {
  const seen = new Set<string>([startId])
  const queue = [startId]
  while (queue.length > 0) {
    for (const e of outOf(def, queue.shift()!)) if (!seen.has(e.target)) { seen.add(e.target); queue.push(e.target) }
  }
  return seen
}

/** The steps between the answer and `id`, inclusive of `id`, walking back along single incoming edges to a response. */
function chainFromAnswer(def: Definition, id: string): DefNode[] | null {
  const nodes = byId(def)
  const chain: DefNode[] = []
  let at = nodes.get(id)
  while (at) {
    if (at.type === 'response') return chain.reverse()
    chain.push(at)
    const incoming = into(def, at.id)
    if (incoming.length !== 1) return null
    at = nodes.get(incoming[0].source)
  }
  return null
}

/** The Submission writes after the answer on the trades present route, found by walking the graph. */
function tradesPresentOutcomeWrites(def: Definition): DefNode[] {
  const branch = nodeByNamespace(def, 'equifax_debt')
  const route = outOf(def, branch.id).find((e) => e.source_handle === 'trades_present')
  if (!route) throw new Error('equifax_debt has no trades_present edge')
  const nodes = byId(def)
  return [...reachable(def, route.target)]
    .map((id) => nodes.get(id))
    .filter((n): n is DefNode => !!n && n.type === 'salesforce' && n.config.operation === 'update' && n.config.object === 'Submission__c')
    .filter((n) => chainFromAnswer(def, n.id) !== null)
}

// ── The engine's own retry rules, modelled once and held to withRetry below ──
const ENGINE_DEFAULT_RETRIES = 2 // engine/index.ts: (node.config.retries as number) ?? 2
const ENGINE_DEFAULT_TIMEOUT_MS = 30_000 // engine/index.ts: (node.config.timeout_ms as number) ?? 30000
const backoffMs = (attempt: number, linear: boolean) => (linear ? 500 * (attempt + 1) : 500 * 2 ** attempt)

/**
 * The longest one step can hold the walk: every attempt runs to its per attempt
 * timeout, with the backoff between attempts. The attempt timeout encloses the
 * whole attempt, so a Salesforce step's token fetch (10 s abort), bulkhead wait
 * (15 s) and call (15 s abort) are all inside it (proved below).
 */
function worstCaseMs(node: DefNode): number {
  const retries = typeof node.config.retries === 'number' ? node.config.retries : ENGINE_DEFAULT_RETRIES
  const timeout = typeof node.config.timeout_ms === 'number' ? node.config.timeout_ms : ENGINE_DEFAULT_TIMEOUT_MS
  const linear = node.config.retry_backoff === 'linear'
  let total = (retries + 1) * timeout
  for (let a = 0; a < retries; a++) total += backoffMs(a, linear)
  return total
}

/**
 * When an Achieve step that starts `startsAtMs` after the answer ends, measured
 * by running it (#2834): the real node inside the engine's own attempt timeout
 * and retries from its settings, a reply that never comes, and the window read
 * from a post-response budget armed at the answer, as the engine wires it.
 */
async function achieveEndsAtMs(node: DefNode, startsAtMs: number): Promise<number> {
  vi.useFakeTimers({ now: 0 })
  try {
    const budget = new PostResponseBudget(realClock)
    budget.arm()
    vi.setSystemTime(startsAtMs)
    const fetchMock = stubFetch()
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }))
    const ctx = buildContext({
      Submission__c: 'a0X000000000001AAA',
      personalInformation: { email: 'lead@example.com', primaryPhone: '6467706541', firstName: 'A', lastName: 'B', state: 'NY' },
      loanInformation: { loanAmount: 12_000 },
    }, 'test', 'wf', 'trace', { ACHIEVE_ENV: 'production', ACHIEVE_USERNAME: 'user', ACHIEVE_PASSWORD: 'pass' }, 'org', 'exec')
    ctx.continuationMsLeft = () => budget.msLeftInContinuationWindow()
    const retries = typeof node.config.retries === 'number' ? node.config.retries : ENGINE_DEFAULT_RETRIES
    const timeout_ms = typeof node.config.timeout_ms === 'number' ? node.config.timeout_ms : ENGINE_DEFAULT_TIMEOUT_MS
    let endedAt: number | null = null
    const step = withRetry((signal) => executeAchieveOffersNode(node as unknown as NodeDefinition, ctx, {} as Env, signal), { retries, backoff: 'exponential', timeout_ms }, () => 'transient')
      .finally(() => { endedAt = Date.now() })
    await vi.runAllTimersAsync()
    await step
    // It reached Achieve, unless it chose not to; either way it ended on its own.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1)
    return endedAt!
  } finally {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
}

/** Each slot of a parallel block, walked from its handle along single edges to the block's join, with its worst case. */
function slotsOf(def: Definition, blockNamespace: string) {
  const nodes = byId(def)
  const block = nodeByNamespace(def, blockNamespace)
  return outOf(def, block.id).filter((e) => (e.source_handle ?? '').startsWith('child-')).sort((a, b) => String(a.source_handle).localeCompare(String(b.source_handle))).map((e) => {
    const steps: DefNode[] = []
    let at = nodes.get(e.target)
    while (at && at.type !== 'parallel_end') {
      steps.push(at)
      const next = outOf(def, at.id)
      if (next.length !== 1) throw new Error(`${at.namespace} has ${next.length} steps after it inside ${blockNamespace}`)
      at = nodes.get(next[0].target)
    }
    return { slot: String(e.source_handle), steps: steps.map((s) => s.namespace), worstMs: steps.reduce((t, s) => t + worstCaseMs(s), 0) }
  })
}

/** The longest a block holds the walk: its slots run side by side, so the longest slot, and never longer than its own timeout (engine/nodes/parallel.ts). */
function blockWorstMs(def: Definition, blockNamespace: string): number {
  return Math.min(Math.max(...slotsOf(def, blockNamespace).map((s) => s.worstMs)), Number(nodeByNamespace(def, blockNamespace).config.timeout_ms))
}

describe('the inquiry post follows every outcome write on the trades present route', () => {
  const writes = tradesPresentOutcomeWrites(ported)

  it('finds the nine outcome writes by walking from equifax_debt, the three exit branches among them', () => {
    expect(writes.map((n) => n.namespace).sort()).toEqual([
      'amone_sf_post', 'debt_missing_sf_post', 'engine_no_bids_sf_post', 'invalid_state_sf_post', 'send_fallback_salesforce',
      'send_fallback_salesforce_1', 'send_salesforce', 'tripoint_sf_post', 'under_10000_sf_post',
    ])
  })

  it('each is followed by the inquiry body step, then its Apex call, sent once, then what followed the write: Achieve, or exit_1 to exit_3', () => {
    const nodes = byId(ported)
    const after = Object.fromEntries(writes.map((write) => {
      const [toBody] = outOf(ported, write.id)
      const body = nodes.get(toBody.target)!
      const [toApex] = outOf(ported, body.id)
      const apex = nodes.get(toApex.target)!
      expect({ write: write.namespace, steps_after: outOf(ported, write.id).length, body: body.type, apex: apex.type, path: apex.config.apex_path }).toEqual({
        write: write.namespace, steps_after: 1, body: 'code', apex: 'salesforce', path: INQUIRY_APEX_PATH,
      })
      expect({ write: write.namespace, ...apex.config }).toMatchObject({ write: write.namespace, operation: 'apex', body: `{{steps.${body.namespace}.output}}`, retries: 0, skip_when_empty: true })
      return [write.namespace, outOf(ported, apex.id).map((e) => nodes.get(e.target)!.namespace)]
    }))
    expect(after).toEqual({
      tripoint_sf_post: ['achieve_tripoint_win'],
      amone_sf_post: ['achieve_amone_win'],
      engine_no_bids_sf_post: ['achieve_no_bids'],
      under_10000_sf_post: ['achieve_under_10k'],
      invalid_state_sf_post: ['achieve_invalid_state'],
      debt_missing_sf_post: ['achieve_debt_missing'],
      send_salesforce: ['exit_1'],
      send_fallback_salesforce: ['exit_2'],
      send_fallback_salesforce_1: ['exit_3'],
    })
  })

  it('every inquiry Apex call runs after the answer; the one collections call runs before it, inside parallel_1', () => {
    const inquiry = ported.nodes.filter((x) => x.config.apex_path === INQUIRY_APEX_PATH)
    expect(inquiry).toHaveLength(9)
    for (const n of inquiry) expect({ apex: n.namespace, afterAnswer: chainFromAnswer(ported, n.id) !== null }).toEqual({ apex: n.namespace, afterAnswer: true })
    const collections = ported.nodes.filter((x) => x.config.apex_path === COLLECTIONS_APEX_PATH)
    expect(collections.map((n) => n.namespace)).toEqual([COLLECTIONS_APEX])
    expect(chainFromAnswer(ported, collections[0].id)).toBeNull()
    const route = outOf(ported, nodeByNamespace(ported, 'equifax_debt').id).find((e) => e.source_handle === 'trades_present')!
    expect(reachable(ported, route.target).has(collections[0].id)).toBe(true)
  })
})

describe('the worst case after the answer fits the 12 s window', () => {
  it('for every outcome write, the steps from the answer through its inquiry Apex call finish inside CONTINUATION_WINDOW_MS', () => {
    const nodes = byId(ported)
    const chains = tradesPresentOutcomeWrites(ported).map((write) => {
      const apex = nodes.get(outOf(ported, nodes.get(outOf(ported, write.id)[0].target)!.id)[0].target)!
      const chain = chainFromAnswer(ported, apex.id)!
      return { write: write.namespace, steps: chain.map((n) => `${n.namespace} ${worstCaseMs(n)}`), worstMs: chain.reduce((t, n) => t + worstCaseMs(n), 0) }
    })
    expect(chains).toHaveLength(9)
    for (const c of chains) expect({ ...c, fits: c.worstMs <= CONTINUATION_WINDOW_MS }).toEqual({ ...c, fits: true })
    // The longest is send_salesforce's branch, which runs calculate_internal_debt
    // (three 150 ms attempts and 1.5 s of backoff) after its answer; every other
    // branch is the 4.5 s write, the 500 ms body step and the 4.5 s Apex call.
    expect(Object.fromEntries(chains.map((c) => [c.write, c.worstMs]))).toEqual({
      tripoint_sf_post: 9_500, amone_sf_post: 9_500, engine_no_bids_sf_post: 9_500, under_10000_sf_post: 9_500, invalid_state_sf_post: 9_500,
      debt_missing_sf_post: 9_500, send_fallback_salesforce: 9_500, send_fallback_salesforce_1: 9_500, send_salesforce: 11_450,
    })
  })

  // #2834: on six branches the inquiry Apex call is followed by Achieve, the last
  // step of the branch that does any work (only branch ends follow it). Its step
  // timeout (15 to 18 s) is not what bounds it: the node ends its own wait first.
  // So it is not added up from its settings like the steps before it; it is RUN,
  // starting at the worst case of the steps before it, against a reply that never
  // comes, with the run's own window, and the time it ends is what is judged.
  it('for every outcome write, the steps from the answer through Achieve, where the branch runs it, finish inside CONTINUATION_WINDOW_MS', async () => {
    const nodes = byId(ported)
    const ends: Record<string, { achieve: string | null; startsAtMs: number; endsAtMs: number }> = {}
    for (const write of tradesPresentOutcomeWrites(ported)) {
      const apex = nodes.get(outOf(ported, nodes.get(outOf(ported, write.id)[0].target)!.id)[0].target)!
      const startsAtMs = chainFromAnswer(ported, apex.id)!.reduce((t, n) => t + worstCaseMs(n), 0)
      const next = outOf(ported, apex.id).map((e) => nodes.get(e.target)!)
      const achieve = next.find((n) => n.type === 'achieve_offers') ?? null
      // Nothing but branch ends follows Achieve, so it is the last step that waits on anything.
      if (achieve) expect({ achieve: achieve.namespace, after: outOf(ported, achieve.id).map((e) => nodes.get(e.target)!.type) }).toEqual({ achieve: achieve.namespace, after: ['branch_end'] })
      ends[write.namespace] = { achieve: achieve?.namespace ?? null, startsAtMs, endsAtMs: achieve ? await achieveEndsAtMs(achieve, startsAtMs) : startsAtMs }
    }
    for (const [write, e] of Object.entries(ends)) expect({ write, ...e, fits: e.endsAtMs <= CONTINUATION_WINDOW_MS }).toEqual({ write, ...e, fits: true })
    // Achieve starts 9.5 s after the answer at worst, with 2.5 s left: under the 4.5 s
    // a send needs (its 500 ms margin and the 4 s shortest wait, the fastest accept
    // measured, #2862), so it sends nothing and ends where it started. The skip is
    // counted by the Achieve window skip check.
    expect(Object.fromEntries(Object.entries(ends).map(([w, e]) => [w, [e.achieve, e.endsAtMs]]))).toEqual({
      tripoint_sf_post: ['achieve_tripoint_win', 9_500], amone_sf_post: ['achieve_amone_win', 9_500], engine_no_bids_sf_post: ['achieve_no_bids', 9_500],
      under_10000_sf_post: ['achieve_under_10k', 9_500], invalid_state_sf_post: ['achieve_invalid_state', 9_500], debt_missing_sf_post: ['achieve_debt_missing', 9_500],
      send_salesforce: [null, 11_450], send_fallback_salesforce: [null, 9_500], send_fallback_salesforce_1: [null, 9_500],
    })
    // #2862: the latest start that still sends is 7.5 s after the answer. It waits
    // the 4 s floor and ends 11.5 s after the answer, the latest any branch ends;
    // a millisecond later it sends nothing.
    const achieveNode = ported.nodes.find((n) => n.type === 'achieve_offers')!
    expect(await achieveEndsAtMs(achieveNode, 7_500)).toBe(11_500)
    expect(await achieveEndsAtMs(achieveNode, 7_501)).toBe(7_501)
  })

  it('the model of a step is the engine: withRetry waits exactly the backoffs it adds up', async () => {
    const transient = Object.assign(new Error('timeout'), { status: 503 })
    for (const [retries, backoff] of [[0, 'exponential'], [2, 'exponential'], [2, 'linear']] as const) {
      const slept: number[] = []
      await withRetry(async () => { throw transient }, { retries, backoff, timeout_ms: 1000 }, () => 'transient', undefined, async (ms) => { slept.push(ms) }).catch(() => {})
      const modelled = Array.from({ length: retries }, (_, a) => backoffMs(a, backoff === 'linear'))
      expect({ retries, backoff, slept }).toEqual({ retries, backoff, slept: modelled })
    }
  })

  describe('a Salesforce step is held to its attempt timeout whatever it is waiting on', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('a token fetch that never answers ends at the step timeout', async () => {
      // No cached token, so the step must fetch one, and that fetch never answers.
      const fetchMock = stubFetch()
      fetchMock.mockImplementation(() => new Promise(() => {}))
      const env = { WORKFLOW_CACHE: { get: vi.fn().mockResolvedValue(null), put: vi.fn(), delete: vi.fn() } } as unknown as Env
      const ctx = buildContext({ Submission__c: 'a0X000000000001AAA' }, 'test', 'wf', 'trace', {
        SALESFORCE_CLIENT_ID: 'id', SALESFORCE_CLIENT_SECRET: 'secret', SALESFORCE_INSTANCE_URL: 'https://example.my.salesforce.com',
      }, 'org', 'exec')
      const node = { ...nodeByNamespace(ported, 'invalid_state_sf_post'), config: { ...nodeByNamespace(ported, 'invalid_state_sf_post').config, timeout_ms: 25 } } as unknown as NodeDefinition
      ctx.steps.fallback_invalid_state = { output: { sfBody: { submissionId: 'a0X000000000001AAA', ADV_SO__c: 1 } } } as never
      const started = Date.now()
      const err = await withRetry((signal) => executeSalesforceNode(node, ctx, env, signal), { retries: 0, backoff: 'exponential', timeout_ms: 25 }, () => 'transient').then(() => null, (e: Error) => e)
      expect(err?.message).toMatch(/Step timed out after 25ms/)
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(['https://example.my.salesforce.com/services/oauth2/token'])
    })
  })
})

describe('the collections slot does not lengthen parallel_1, before the answer (#2832)', () => {
  /** Version 169 with the canaries applied (the parallel_1 live Main Flow held until version 177), with and without the collections stage. */
  const without = portMainFlow(productionMainFlow(), PORT_STAGES.canary_send_salesforce)
  const withSlot = portMainFlow(productionMainFlow(), PORT_STAGES.collections)

  it('each slot\'s worst case, from its steps\' own settings: the trades chain far past 4.5 s, the collections slot 5 s', () => {
    expect(slotsOf(withSlot, 'parallel_1')).toEqual([
      // trades_body (150 ms, the default two retries) 1,950; trades_request (16.5 s, two retries) 51,000; pennie_debt_calculation (20 ms, two retries) 1,560.
      { slot: 'child-0', steps: ['trades_body', 'trades_request', 'pennie_debt_calculation'], worstMs: 54_510 },
      { slot: 'child-1', steps: ['send_salesforce_inquiry'], worstMs: 18_000 },
      { slot: COLLECTIONS_SLOT, steps: [COLLECTIONS_BODY, COLLECTIONS_APEX], worstMs: 5_000 },
    ])
  })

  it('the block\'s worst case is its 20 s timeout with the slot and without it, so the slot adds nothing to it', () => {
    expect(blockWorstMs(without, 'parallel_1')).toBe(20_000)
    expect(blockWorstMs(withSlot, 'parallel_1')).toBe(20_000)
  })

  it('the collections slot ends on its own deadline, inside the block\'s timeout and the trades chain\'s worst case', () => {
    const slots = slotsOf(withSlot, 'parallel_1')
    const collections = slots.find((s) => s.slot === COLLECTIONS_SLOT)!.worstMs
    expect(collections).toBeLessThan(Number(nodeByNamespace(withSlot, 'parallel_1').config.timeout_ms))
    expect(collections).toBeLessThan(slots.find((s) => s.slot === 'child-0')!.worstMs)
  })

  it('live Main Flow holds the slot since version 177 (2026-10-28), with the same steps and worst cases as built here', () => {
    const live = (JSON.parse(GATE_MAIN_FLOW_RAW as string) as { definition: Definition }).definition
    expect(slotsOf(live, 'parallel_1')).toEqual(slotsOf(withSlot, 'parallel_1'))
    expect(blockWorstMs(live, 'parallel_1')).toBe(20_000)
  })

  it('the same holds once the inquiry relay has left parallel_1', () => {
    expect(slotsOf(ported, 'parallel_1').map((s) => s.slot)).toEqual(['child-0', COLLECTIONS_SLOT])
    expect(blockWorstMs(ported, 'parallel_1')).toBe(20_000)
  })
})
describe('the ported definition is one the save route and the engine accept', () => {
  it('every success_node_namespaces entry is a node', () => {
    const list = (ported.trigger as { config: { success_node_namespaces: string[] } }).config.success_node_namespaces
    const namespaces = new Set(ported.nodes.map((n) => n.namespace))
    expect(list.filter((ns) => !namespaces.has(ns))).toEqual([])
    expect(list).toEqual((before.trigger as { config: { success_node_namespaces: string[] } }).config.success_node_namespaces)
  })

  it('no step names either relay', () => {
    const urls = relayUrls(before)
    const naming = ported.nodes.filter((n) => {
      const text = JSON.stringify(n)
      return text.includes(new URL(urls.submission).host) || text.includes(new URL(urls.inquiries).host)
    })
    expect(naming.map((n) => n.namespace)).toEqual([])
  })

  // The definition rules alone; save-route-contract.test.ts sends each stage through the real route (#2174).
  it('passes the save route\'s definition rules: no loop, no malformed Salesforce write option', () => {
    expect(findWorkflowCycle(ported.nodes, ported.edges)).toBeNull()
    expect(findSalesforceConfigProblems(ported.nodes)).toEqual([])
  })

  it('adds no canvas validation problem and no reference to a step that has not run', () => {
    const key = (p: { namespace?: string; message: string }) => `${p.namespace}: ${p.message}`
    const baseConfig = new Set(validateWorkflowDef(before.nodes, before.edges).map(key))
    expect(validateWorkflowDef(ported.nodes, ported.edges).map(key).filter((k) => !baseConfig.has(k))).toEqual([])
    const baseRefs = new Set(validateDefinitionReferences(before.nodes, before.edges).map(key))
    expect(validateDefinitionReferences(ported.nodes, ported.edges).map(key).filter((k) => !baseRefs.has(k))).toEqual([])
  })
})

describe('the inquiry body step', () => {
  const script = String(nodeByNamespace(ported, 'inquiry_body_tripoint_sf_post').config.script)
  const report = (inquiries: unknown) => ({ output: { data: { consumers: { equifaxUSConsumerCreditReport: [{ inquiries, trades: [{}] }] } } } })
  const run = (route: string | undefined, inquiries: unknown, submission: string | null = 'a0X000000000001AAA') =>
    runCanvasScript(script, {
      payload: submission === null ? {} : { Submission__c: submission },
      steps: { ...(route ? { equifax_debt: { output: { _route: route } } } : {}), equifax_credit_report: report(inquiries) },
    })

  it('builds the relay body, inquiries as JSON text with null valued keys dropped', async () => {
    const body = await run('trades_present', [{ industryCode: 'BB', inquiryDate: '2026-09-01', customerNumber: null }, null])
    expect(body).toEqual({
      submissionId: 'a0X000000000001AAA',
      inquiriesJson: JSON.stringify({ inquiries: [{ industryCode: 'BB', inquiryDate: '2026-09-01' }] }),
    })
  })

  it('is null, so the call is skipped, off the trades present route, with no inquiries, or with no Submission', async () => {
    const one = [{ industryCode: 'BB' }]
    expect(await run('trades_missing', one)).toBeNull()
    expect(await run(undefined, one)).toBeNull()
    expect(await run('trades_present', [])).toBeNull()
    expect(await run('trades_present', undefined)).toBeNull()
    expect(await run('trades_present', [null])).toBeNull()
    expect(await run('trades_present', one, null)).toBeNull()
  })

  describe('through the real Salesforce executor', () => {
    afterEach(() => vi.unstubAllGlobals())
    const env = { WORKFLOW_CACHE: { get: vi.fn().mockResolvedValue('tok'), put: vi.fn(), delete: vi.fn() } } as unknown as Env
    const ctxWith = (output: unknown) => {
      const ctx = buildContext({ Submission__c: 'a0X000000000001AAA' }, 'test', 'wf', 'trace', {
        SALESFORCE_CLIENT_ID: 'id', SALESFORCE_CLIENT_SECRET: 'secret', SALESFORCE_INSTANCE_URL: 'https://example.my.salesforce.com',
      }, 'org', 'exec')
      ctx.steps.inquiry_body_tripoint_sf_post = { output } as never
      return ctx
    }
    const apex = nodeByNamespace(ported, 'inquiry_apex_tripoint_sf_post') as unknown as NodeDefinition

    it('a null body makes no call at all', async () => {
      const fetchMock = stubFetch()
      const result = await executeSalesforceNode(apex, ctxWith(null), env)
      expect(result.output).toEqual({ skipped: true, skip_reason: 'nothing_to_write' })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('a body is POSTed once to credit-inquiries as it was built', async () => {
      const fetchMock = stubFetch()
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: 'Inquiries inserted successfully', statusCode: 200 }), { status: 200 }))
      const body = { submissionId: 'a0X000000000001AAA', inquiriesJson: '{"inquiries":[{"industryCode":"BB"}]}' }
      await executeSalesforceNode(apex, ctxWith(body), env)
      expect(fetchMock.mock.calls.map((c) => [String(c[0]), c[1].method, JSON.parse(c[1].body as string)])).toEqual([
        ['https://example.my.salesforce.com/services/apexrest/credit-inquiries', 'POST', body],
      ])
    })
  })
})

describe('the collections body step (#2832)', () => {
  const script = String(nodeByNamespace(ported, COLLECTIONS_BODY).config.script)
  const report = (fields: Record<string, unknown>) => ({ output: { data: { consumers: { equifaxUSConsumerCreditReport: [{ trades: [{}], ...fields }] } } } })
  const run = (fields: Record<string, unknown>, submission: string | null = 'a0X000000000001AAA') =>
    runCanvasScript(script, {
      payload: submission === null ? {} : { Submission__c: submission },
      steps: { equifax_credit_report: report(fields) },
    })

  it('sends { submissionId, collectionsJSON }, spelt as Geoff\'s example spells it, collectionsJSON the JSON text of { collections }', async () => {
    const body = await run({ collections: [{ industryCode: 'YC', balance: 412 }] })
    expect(Object.keys(body as object)).toEqual(['submissionId', 'collectionsJSON'])
    expect(body).toEqual({ submissionId: 'a0X000000000001AAA', collectionsJSON: '{"collections":[{"industryCode":"YC","balance":412}]}' })
  })

  it('sends every item whole, its account number among them, and drops only null valued keys, as trades_body does', async () => {
    const item = {
      industryCode: 'YC', customerNumber: '123ZZ45678', accountNumber: '9988776655', balance: 412, originalBalance: 700,
      dateReported: '09012026', creditorClassification: { code: '02', description: 'Medical/Health Care' }, narrativeCodes: [{ code: 'FA' }], status: null,
    }
    const body = await run({ collections: [item, { industryCode: 'YC', balance: 0, comment: '' }] })
    const { status: _dropped, ...kept } = item
    expect(body).toEqual({
      submissionId: 'a0X000000000001AAA',
      collectionsJSON: JSON.stringify({ collections: [kept, { industryCode: 'YC', balance: 0, comment: '' }] }),
    })
    expect(JSON.parse((body as { collectionsJSON: string }).collectionsJSON).collections[0].accountNumber).toBe('9988776655')
  })

  it('sends an empty list when the report has no collections key, or it is null, or it is empty: Equifax leaves the key out for a file with none', async () => {
    const empty = { submissionId: 'a0X000000000001AAA', collectionsJSON: '{"collections":[]}' }
    expect(await run({})).toEqual(empty)
    expect(await run({ collections: null })).toEqual(empty)
    expect(await run({ collections: [] })).toEqual(empty)
  })

  it('is null, so the call is skipped, only when the lead has no Submission', async () => {
    expect(await run({ collections: [{ industryCode: 'YC' }] }, null)).toBeNull()
    expect(await run({}, null)).toBeNull()
  })

  it('fails the step by name on a collections value that is present but not a list, or an item that is not an object', async () => {
    await expect(run({ collections: { industryCode: 'YC' } })).rejects.toThrow(/collections_body: the credit report's collections is a object, not a list/)
    await expect(run({ collections: 'none' })).rejects.toThrow(/collections_body: .* is a string, not a list/)
    await expect(run({ collections: [{ industryCode: 'YC' }, null] })).rejects.toThrow(/collections_body: collection item 1 is not an object/)
  })

  describe('through the real Salesforce executor', () => {
    afterEach(() => vi.unstubAllGlobals())
    const env = { WORKFLOW_CACHE: { get: vi.fn().mockResolvedValue('tok'), put: vi.fn(), delete: vi.fn() } } as unknown as Env
    const ctxWith = (output: unknown) => {
      const ctx = buildContext({ Submission__c: 'a0X000000000001AAA' }, 'test', 'wf', 'trace', {
        SALESFORCE_CLIENT_ID: 'id', SALESFORCE_CLIENT_SECRET: 'secret', SALESFORCE_INSTANCE_URL: 'https://example.my.salesforce.com',
      }, 'org', 'exec')
      ctx.steps[COLLECTIONS_BODY] = { output } as never
      return ctx
    }
    const apex = nodeByNamespace(ported, COLLECTIONS_APEX) as unknown as NodeDefinition

    it('a null body (no Submission) makes no call at all', async () => {
      const fetchMock = stubFetch()
      const result = await executeSalesforceNode(apex, ctxWith(null), env)
      expect(result.output).toEqual({ skipped: true, skip_reason: 'nothing_to_write' })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('a body with an empty list is still POSTed, once, to credit-collections as it was built', async () => {
      const fetchMock = stubFetch()
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: 'ok', statusCode: 200 }), { status: 200 }))
      const body = { submissionId: 'a0X000000000001AAA', collectionsJSON: '{"collections":[]}' }
      await executeSalesforceNode(apex, ctxWith(body), env)
      expect(fetchMock.mock.calls.map((c) => [String(c[0]), c[1].method, JSON.parse(c[1].body as string)])).toEqual([
        ['https://example.my.salesforce.com/services/apexrest/credit-collections', 'POST', body],
      ])
    })
  })
})
