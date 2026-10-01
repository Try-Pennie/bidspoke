import { describe, it, expect } from 'vitest'
import { compareTranscripts, coverageReport, formatDifferences, type FixtureRecord, type Transcript } from '../compare'

function fixture(over: Partial<FixtureRecord> = {}): FixtureRecord {
  return {
    id: 'engine/tripoint_wins',
    workflow_id: 'w1',
    workflow_name: 'Engine Bidding Workflow',
    variant: 'tripoint_wins',
    trigger: { payload: { a: 1 }, source: 'engine' },
    routes: [{ node: 'n-branch', namespace: 'route_bid', type: 'branch', route: 'tripoint' }],
    nodes_executed: ['constants', 'route_bid', 'tripoint_ping'],
    final_node: 'patch_prospect',
    response: { status: 200, body: { offers: [] } },
    outbound: [{ via: 'code', node: 'tripoint_ping', method: 'POST', host: 'tripoint-proxy.trypennie.dev', path: '/ping', headers: {}, body: { debt: 25000, state: 'TX' } }],
    code_dispatch: [{ binding: 'DYNAMIC_WORKER_LOADER', name: 'bs-wf-da82a183', path: '/execute-chain', namespaces: ['tripoint_ping'] }],
    supabase_writes: [{ op: 'insert', table: 'execution_steps', values: [{ step_namespace: 'constants' }] }],
    do_state: { DAILY_CAP: {} },
    kv_state: { SUBMISSIONS: {} },
    ...over,
  }
}

function transcript(side: 'base' | 'head', fixtures: FixtureRecord[]): Transcript {
  return {
    version: 1,
    side,
    fixtures,
    workflows: [{
      workflow_id: 'w1', workflow_name: 'Engine Bidding Workflow',
      nodes: ['constants', 'route_bid', 'tripoint_ping', 'patch_prospect', 'reject'],
      arms: [{ node: 'n-branch', namespace: 'route_bid', handles: ['tripoint', 'else'] }],
    }],
    unstubbed_hosts: [],
    unknown_tables: [],
  }
}

describe('compareTranscripts', () => {
  it('finds nothing when base and head agree', () => {
    expect(compareTranscripts(transcript('base', [fixture()]), transcript('head', [fixture()]))).toEqual([])
  })

  it('names the route check, the fixture and the node when a branch routes differently', () => {
    const head = fixture({ routes: [{ node: 'n-branch', namespace: 'route_bid', type: 'branch', route: 'else' }] })
    const d = compareTranscripts(transcript('base', [fixture()]), transcript('head', [head]))
    expect(d[0]).toMatchObject({ check: 'route', fixture: 'engine/tripoint_wins', node: 'route_bid', field: 'route', base: 'tripoint', head: 'else' })
  })

  it('names the outbound request check and the dropped body field', () => {
    const head = fixture({ outbound: [{ ...fixture().outbound[0], body: { state: 'TX' } }] })
    const d = compareTranscripts(transcript('base', [fixture()]), transcript('head', [head]))
    expect(d).toEqual([expect.objectContaining({ check: 'outbound_request', node: 'tripoint_ping', field: 'outbound[0] POST tripoint-proxy.trypennie.dev/ping body.debt', base: 25000, head: undefined })])
  })

  it('names the code namespace check when a call resolves to another script', () => {
    const head = fixture({ code_dispatch: [{ binding: 'DYNAMIC_WORKER_LOADER', name: 'bs-cmp-da82a183', path: '/execute-chain', namespaces: ['tripoint_ping'] }] })
    const d = compareTranscripts(transcript('base', [fixture()]), transcript('head', [head]))
    expect(d[0]).toMatchObject({ check: 'code_namespace', node: 'tripoint_ping', field: 'code_dispatch[0].name', base: 'bs-wf-da82a183', head: 'bs-cmp-da82a183' })
  })

  it('checks the response, the final node, writes, durable object and KV state and the golden trigger', () => {
    const head = fixture({
      response: { status: 500, body: { offers: [] } },
      final_node: 'reject',
      supabase_writes: [],
      do_state: { DAILY_CAP: { k: 1 } },
      kv_state: { SUBMISSIONS: { x: 'y' } },
      trigger: { payload: { a: 2 }, source: 'engine' },
    })
    const checks = compareTranscripts(transcript('base', [fixture()]), transcript('head', [head])).map((d) => d.check)
    expect(new Set(checks)).toEqual(new Set(['response', 'final_node', 'supabase_write', 'do_state', 'kv_state', 'golden_trigger']))
  })

  it('reports a fixture present on one side only', () => {
    const d = compareTranscripts(transcript('base', [fixture()]), transcript('head', []))
    expect(d[0]).toMatchObject({ check: 'fixture_set', fixture: 'engine/tripoint_wins' })
  })

  it('compares outbound requests as a set: concurrent partner calls finish in either order', () => {
    const a = fixture().outbound[0]
    const b = { ...a, host: 'am-one-proxy.trypennie.dev', path: '/leads/ping' }
    const d = compareTranscripts(transcript('base', [fixture({ outbound: [a, b] })]), transcript('head', [fixture({ outbound: [b, a] })]))
    expect(d).toEqual([])
  })

  it('compares the rows inside one write as a set, since parallel children log in either order', () => {
    const rows = [{ step_namespace: 'bid_race.tripoint', step_order: 21 }, { step_namespace: 'bid_race.amone', step_order: 21 }]
    const d = compareTranscripts(
      transcript('base', [fixture({ supabase_writes: [{ op: 'insert', table: 'execution_steps', values: rows }] })]),
      transcript('head', [fixture({ supabase_writes: [{ op: 'insert', table: 'execution_steps', values: [rows[1], rows[0]] }] })]),
    )
    expect(d).toEqual([])
  })

  it('compares supabase writes as a set, so an ordering race is not a difference', () => {
    const w = [
      { op: 'insert' as const, table: 'a', values: [1] },
      { op: 'insert' as const, table: 'b', values: [2] },
    ]
    const d = compareTranscripts(transcript('base', [fixture({ supabase_writes: w })]), transcript('head', [fixture({ supabase_writes: [w[1], w[0]] })]))
    expect(d).toEqual([])
  })
})

describe('coverageReport', () => {
  it('lists arms reached and not reached by name and the nodes executed', () => {
    const r = coverageReport(transcript('head', [fixture()]))
    expect(r.failures).toEqual([])
    expect(r.text).toContain('Engine Bidding Workflow')
    expect(r.text).toContain('route_bid -> tripoint')
    expect(r.text).toMatch(/not reached:.*route_bid -> else/)
    expect(r.text).toContain('nodes executed 3 of 5')
    expect(r.text).toMatch(/not executed:.*patch_prospect.*reject/)
  })

  it('fails a workflow that executed no node', () => {
    const r = coverageReport(transcript('head', [fixture({ nodes_executed: [], routes: [] })]))
    expect(r.failures).toEqual(['Engine Bidding Workflow executed no node in any fixture'])
  })
})

describe('formatDifferences', () => {
  it('prints one line per difference naming fixture, check, node and field', () => {
    const head = fixture({ routes: [{ node: 'n-branch', namespace: 'route_bid', type: 'branch', route: 'else' }] })
    const text = formatDifferences(compareTranscripts(transcript('base', [fixture()]), transcript('head', [head])))
    expect(text).toContain('[route] engine/tripoint_wins node route_bid field route: base "tripoint" head "else"')
  })
})
