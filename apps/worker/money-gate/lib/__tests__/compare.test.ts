import { describe, it, expect } from 'vitest'
import { compareTranscripts, coverageReport, formatDifferences, type FixtureRecord, type Transcript } from '../compare'
import type { RunKind } from '../run-kinds'

function fixture(over: Partial<FixtureRecord> = {}): FixtureRecord {
  return {
    id: 'engine/tripoint_wins',
    workflow_id: 'w1',
    workflow_name: 'Engine Bidding Workflow',
    variant: 'tripoint_wins',
    run_kind: 'live',
    trigger: { payload: { a: 1 }, source: 'engine' },
    routes: [{ node: 'n-branch', namespace: 'route_bid', type: 'branch', route: 'tripoint' }],
    nodes_executed: ['constants', 'route_bid', 'tripoint_ping'],
    final_node: 'patch_prospect',
    response: { status: 200, body: { offers: [] } },
    outbound: [{ via: 'code', node: 'tripoint_ping', method: 'POST', host: 'tripoint-proxy.trypennie.dev', path: '/ping', headers: {}, body: { debt: 25000, state: 'TX' } }],
    code_dispatch: [{ binding: 'DYNAMIC_WORKER_LOADER', dispatch_namespace: 'bidspoke-code-nodes', name: 'bs-wf-da82a183', path: '/execute-chain', namespaces: ['tripoint_ping'] }],
    supabase_writes: [{ op: 'insert', table: 'execution_steps', values: [{ step_namespace: 'constants' }] }],
    do_state: { DAILY_CAP: {} },
    kv_state: { SUBMISSIONS: {} },
    ...over,
  }
}

/** The same lead as a test run and a dry_run shadow run, which every workflow replays (#1730). */
function asKind(f: FixtureRecord, kind: RunKind, label: string): FixtureRecord {
  return { ...f, id: `${f.id} as ${label}`, run_kind: kind }
}
const withKinds = (f: FixtureRecord): FixtureRecord[] => [f, asKind(f, 'test', 'test run'), asKind(f, 'shadow_dry_run', 'shadow dry_run')]

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
    const head = fixture({ code_dispatch: [{ ...fixture().code_dispatch[0], name: 'bs-cmp-da82a183' }] })
    const d = compareTranscripts(transcript('base', [fixture()]), transcript('head', [head]))
    expect(d[0]).toMatchObject({ check: 'code_namespace', node: 'tripoint_ping', field: 'code_dispatch[0].name', base: 'bs-wf-da82a183', head: 'bs-cmp-da82a183' })
  })

  it('names the code namespace check when a shadow run dispatches through another dispatch namespace', () => {
    const base = asKind(fixture(), 'shadow_dry_run', 'shadow dry_run')
    const head = { ...base, code_dispatch: [{ ...base.code_dispatch[0], binding: 'COMPARE_CODE_LOADER', dispatch_namespace: 'bidspoke-code-compare' }] }
    const d = compareTranscripts(transcript('base', [base]), transcript('head', [head]))
    expect(d.map((x) => [x.check, x.fixture, x.field, x.base, x.head])).toEqual([
      ['code_namespace', 'engine/tripoint_wins as shadow dry_run', 'code_dispatch[0].binding', 'DYNAMIC_WORKER_LOADER', 'COMPARE_CODE_LOADER'],
      ['code_namespace', 'engine/tripoint_wins as shadow dry_run', 'code_dispatch[0].dispatch_namespace', 'bidspoke-code-nodes', 'bidspoke-code-compare'],
    ])
  })

  it('compares a test run base against head with the same checks as a live run: a lost request is named', () => {
    const base = asKind(fixture(), 'test', 'test run')
    const d = compareTranscripts(transcript('base', [base]), transcript('head', [{ ...base, outbound: [] }]))
    expect(d[0]).toMatchObject({ check: 'outbound_request', fixture: 'engine/tripoint_wins as test run', field: 'outbound.length', base: 1, head: 0 })
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
    const r = coverageReport(transcript('head', withKinds(fixture())))
    expect(r.failures).toEqual([])
    expect(r.text).toContain('Engine Bidding Workflow')
    expect(r.text).toContain('route_bid -> tripoint')
    expect(r.text).toMatch(/not reached:.*route_bid -> else/)
    expect(r.text).toContain('nodes executed 3 of 5')
    expect(r.text).toMatch(/not executed:.*patch_prospect.*reject/)
  })

  it('fails a workflow that executed no node', () => {
    const r = coverageReport(transcript('head', withKinds(fixture({ nodes_executed: [], routes: [] }))))
    expect(r.failures).toContain('Engine Bidding Workflow executed no node in any fixture')
  })

  it('counts the fixtures by run kind and says, per test and shadow run, what it executed, sent and dispatched to', () => {
    const live = fixture({ outbound: [...fixture().outbound, { ...fixture().outbound[0], via: 'engine', node: 'patch' }] })
    const shadow = { ...asKind(live, 'shadow_dry_run', 'shadow dry_run'), outbound: [] }
    const r = coverageReport(transcript('head', [live, asKind(live, 'test', 'test run'), shadow]))
    expect(r.failures).toEqual([])
    expect(r.text).toContain('Engine Bidding Workflow: 3 fixtures (1 live, 1 test run, 1 shadow dry_run), nodes executed 3 of 5')
    expect(r.text).toContain('  as test run: tripoint_wins, 3 nodes executed, 2 requests sent (1 by the engine, 1 by code), code dispatched to DYNAMIC_WORKER_LOADER (bidspoke-code-nodes) bs-wf-da82a183')
    expect(r.text).toContain('  as shadow dry_run: tripoint_wins, 3 nodes executed, no request sent, code dispatched to DYNAMIC_WORKER_LOADER (bidspoke-code-nodes) bs-wf-da82a183')
  })

  it('fails a workflow replayed as no test run or no shadow run, naming the kind, since a missing kind compares equal to anything', () => {
    const r = coverageReport(transcript('head', [fixture(), asKind(fixture(), 'test', 'test run')]))
    expect(r.failures).toEqual(['Engine Bidding Workflow replayed no shadow dry_run fixture'])
  })

  // #1780: a shadow run of a workflow carrying a code node is refused before
  // any node runs. The refusal is the outcome measured, so it is reported, not
  // read as a replay that checked nothing.
  const refused = (f: FixtureRecord): FixtureRecord => ({
    ...asKind({ ...f, nodes_executed: [], routes: [], outbound: [], code_dispatch: [] }, 'shadow_dry_run', 'shadow dry_run'),
    error: 'ShadowRunRefusedError: A shadow run of this workflow is refused before anything runs. prep is a code node, and a reason.',
  })

  it('counts a shadow run the engine refused by name as measured, and says it was refused', () => {
    const r = coverageReport(transcript('head', [fixture(), asKind(fixture(), 'test', 'test run'), refused(fixture())]))
    expect(r.failures).toEqual([])
    expect(r.text).toContain('  as shadow dry_run: tripoint_wins, refused before anything ran: A shadow run of this workflow is refused before anything runs. prep is a code node, and a reason.')
  })

  it('still fails a shadow run that executed no node for any other reason, a throw included', () => {
    const threw = { ...refused(fixture()), error: 'Error: Failed to load workflow wf-1: timeout' }
    const r = coverageReport(transcript('head', [fixture(), asKind(fixture(), 'test', 'test run'), threw]))
    expect(r.failures).toEqual(['Engine Bidding Workflow executed no node as a shadow dry_run'])
  })

  it('fails a workflow whose test runs executed no node, though its live runs did', () => {
    const r = coverageReport(transcript('head', [fixture(), asKind(fixture({ nodes_executed: [], routes: [] }), 'test', 'test run'), asKind(fixture(), 'shadow_dry_run', 'shadow dry_run')]))
    expect(r.failures).toEqual(['Engine Bidding Workflow executed no node as a test run'])
  })
})

describe('formatDifferences', () => {
  it('prints one line per difference naming fixture, check, node and field', () => {
    const head = fixture({ routes: [{ node: 'n-branch', namespace: 'route_bid', type: 'branch', route: 'else' }] })
    const text = formatDifferences(compareTranscripts(transcript('base', [fixture()]), transcript('head', [head])))
    expect(text).toContain('[route] engine/tripoint_wins node route_bid field route: base "tripoint" head "else"')
  })
})
