import { describe, expect, it } from 'vitest'
import {
  OUTAGE_SHAPES,
  applyExemptions,
  compareOutage,
  decisionsFrom,
  isLastGoodKey,
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
    const call = net.fetch('https://supabase-url.placeholder.invalid/rest/v1/workflows?id=eq.1', { method: 'GET' })
    if (shape === 'refused') {
      await expect(call).rejects.toThrow(TypeError)
    } else {
      const res = await call
      expect(res.status).toBeGreaterThanOrEqual(500)
    }
    expect(net.requests()).toBe(1)
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

  it('orders outbound requests before comparing, since parallel calls land in either order', () => {
    const two = { ...base, outbound: [base.outbound[0], { ...base.outbound[0], host: 'am-one-proxy.trypennie.dev' }] }
    const swapped = { ...two, outbound: [two.outbound[1], two.outbound[0]] }
    expect(compareOutage(two, swapped)).toEqual([])
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

  it('fails an entry that matched nothing, so a fixed flow cannot stay exempt', () => {
    const r = applyExemptions([], [ex()], today)
    expect(r.failures.join('\n')).toMatch(/matched no difference.*#1845/)
  })
})
