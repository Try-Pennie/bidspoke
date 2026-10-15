/**
 * The ported Main Flow, as the transform builds it from the production
 * definition (#2171, #1680 plan points 1, 3, 5, 10 and amendment 3).
 *
 * These judge the graph the apply would PUT, by walking it, not by reading the
 * transform's own lists: which writes run on the trades present path is
 * computed from equifax_debt's edges, and the worst case after the answer is
 * computed from each step's own settings with the engine's own retry rules.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findSalesforceConfigProblems, findWorkflowCycle, validateDefinitionReferences, validateWorkflowDef } from '@bidspoke/workflow-definition'
import type { Env } from '../../../index'
import type { NodeDefinition } from '../../../types'
import { CONTINUATION_WINDOW_MS } from '../../post-response-budget'
import { withRetry } from '../../../engine/retry'
import { buildContext } from '../../../engine/context'
import { executeSalesforceNode } from '../../../engine/nodes/salesforce'
import { runCanvasScript } from '../../../engine/scripts/__tests__/canvas-script'
import { stubFetch } from '../../../__tests__/helpers/fetch-mock'
import { PORT_STAGES, portMainFlow, type DefNode, type Definition } from '../transform'
import { nodeByNamespace, productionMainFlow, relayUrls } from './production-fixture'

const before = productionMainFlow()
const ported = portMainFlow(productionMainFlow(), PORT_STAGES.inquiry)

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

describe('the Apex call follows every outcome write on the trades present route', () => {
  const writes = tradesPresentOutcomeWrites(ported)

  it('finds the nine outcome writes by walking from equifax_debt, the three exit branches among them', () => {
    expect(writes.map((n) => n.namespace).sort()).toEqual([
      'amone_sf_post', 'debt_missing_sf_post', 'engine_no_bids_sf_post', 'invalid_state_sf_post', 'send_fallback_salesforce',
      'send_fallback_salesforce_1', 'send_salesforce', 'tripoint_sf_post', 'under_10000_sf_post',
    ])
  })

  it('each is followed by a body step and then a credit-inquiries Apex call that reads it and is never resent', () => {
    const nodes = byId(ported)
    for (const write of writes) {
      const [toBody] = outOf(ported, write.id)
      const body = nodes.get(toBody.target)!
      const [toApex] = outOf(ported, body.id)
      const apex = nodes.get(toApex.target)!
      expect({ write: write.namespace, steps_after: outOf(ported, write.id).length, body: body.type, apex: apex.type }).toEqual({ write: write.namespace, steps_after: 1, body: 'code', apex: 'salesforce' })
      expect({ write: write.namespace, ...apex.config }).toMatchObject({
        write: write.namespace,
        operation: 'apex',
        apex_path: '/services/apexrest/credit-inquiries',
        body: `{{steps.${body.namespace}.output}}`,
        retries: 0,
        skip_when_empty: true,
      })
    }
  })

  it('the Apex call comes before what followed the write: the branch Achieve step, or exit_1 to exit_3', () => {
    const nodes = byId(ported)
    const after = Object.fromEntries(writes.map((w) => {
      const body = nodes.get(outOf(ported, w.id)[0].target)!
      const apex = nodes.get(outOf(ported, body.id)[0].target)!
      return [w.namespace, outOf(ported, apex.id).map((e) => nodes.get(e.target)!.namespace)]
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

  it('no Apex call runs before the answer', () => {
    for (const n of ported.nodes.filter((x) => x.config.apex_path === '/services/apexrest/credit-inquiries')) {
      expect({ apex: n.namespace, afterAnswer: chainFromAnswer(ported, n.id) !== null }).toEqual({ apex: n.namespace, afterAnswer: true })
    }
  })
})

describe('the worst case after the answer fits the 12 s window', () => {
  it('for every Apex call, the steps from the answer to it finish inside CONTINUATION_WINDOW_MS', () => {
    const chains = ported.nodes.filter((n) => n.config.apex_path === '/services/apexrest/credit-inquiries').map((apex) => {
      const chain = chainFromAnswer(ported, apex.id)!
      return { apex: apex.namespace, steps: chain.map((n) => `${n.namespace} ${worstCaseMs(n)}`), worstMs: chain.reduce((t, n) => t + worstCaseMs(n), 0) }
    })
    expect(chains).toHaveLength(9)
    for (const c of chains) expect({ ...c, fits: c.worstMs <= CONTINUATION_WINDOW_MS }).toEqual({ ...c, fits: true })
    // The longest is send_salesforce's branch, which runs calculate_internal_debt
    // (three 150 ms attempts and 1.5 s of backoff) after its answer.
    expect(Math.max(...chains.map((c) => c.worstMs))).toBe(11_450)
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

  it('passes the save route: no loop, no malformed Salesforce write option', () => {
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
