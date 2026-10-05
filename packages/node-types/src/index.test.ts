/**
 * @bidspoke/node-types: the one list of node types a saved definition can
 * carry, and the traits each one has (#1411, milestone 52). Both apps re-export
 * it, so a type added here reaches every switch, record and set that must know
 * about it, and a switch that forgets one is a compile error at assertNever.
 */
import { describe, expect, it } from 'vitest'
import { NODE_TRAITS, NODE_TYPES, WORKFLOW_LANES, assertNever, isNodeType, isWorkflowLane, nodeTypeRunsInLane, nodeTypesForLane, type NodeType } from './index'

const SORTED = [
  'achieve_offers', 'bid_group', 'branch', 'branch_end', 'buyer_click_check', 'buyer_click_send', 'buyer_select', 'code', 'constants', 'data_store', 'exit', 'filter',
  'latency_gate', 'parallel', 'parallel_end', 'partner_bid', 'response', 'salesforce', 'transform', 'webhook',
]

const withTrait = (pick: (t: (typeof NODE_TRAITS)[NodeType]) => boolean): string[] =>
  NODE_TYPES.filter((t) => pick(NODE_TRAITS[t])).sort()

describe('NODE_TYPES', () => {
  it('lists the twenty node types a saved definition can carry, once each', () => {
    expect([...NODE_TYPES].sort()).toEqual(SORTED)
    expect(new Set(NODE_TYPES).size).toBe(NODE_TYPES.length)
  })

  it('does not list trigger, region or integration: canvas only, a grouping frame, and a spelling no live definition carries', () => {
    for (const notAType of ['trigger', 'region', 'integration']) expect(isNodeType(notAType), notAType).toBe(false)
  })

  it('isNodeType narrows a string read from a definition', () => {
    expect(isNodeType('bid_group')).toBe(true)
    expect(isNodeType('bid-group')).toBe(false)
    expect(isNodeType(undefined)).toBe(false)
    expect(isNodeType(7)).toBe(false)
  })
})

describe('NODE_TRAITS', () => {
  it('has exactly one entry per node type', () => {
    expect(Object.keys(NODE_TRAITS).sort()).toEqual(SORTED)
  })

  it('names the network nodes: the ones whose every run pays an outbound round trip', () => {
    expect(withTrait((t) => t.network)).toEqual(['achieve_offers', 'bid_group', 'buyer_click_send', 'buyer_select', 'partner_bid', 'salesforce', 'webhook'])
  })

  it('names the dispatch or storage nodes: a cold path no retry can rescue', () => {
    expect(withTrait((t) => t.dispatchOrDb)).toEqual(['buyer_click_check', 'code', 'constants', 'data_store', 'latency_gate'])
  })

  // What a shadow run does with each node (#1780): a shadow run must send
  // nothing, so a node either sends nothing anyway, has its outbound stubbed by
  // the run, or makes the whole shadow run refuse.
  it('stubs every network node on a shadow run or refuses it, so none is ever trusted to send nothing', () => {
    expect(withTrait((t) => t.network && t.shadowRun.kind === 'sends_nothing')).toEqual([])
  })

  it('names the nodes whose outbound or writes a shadow run stubs', () => {
    expect(withTrait((t) => t.shadowRun.kind === 'stubbed')).toEqual([
      'achieve_offers', 'bid_group', 'buyer_click_send', 'buyer_select', 'data_store', 'latency_gate', 'partner_bid', 'salesforce', 'webhook',
    ])
  })

  it('refuses a shadow run of a code node, with the reason, since its scripts make their real calls', () => {
    expect(withTrait((t) => t.shadowRun.kind === 'refused')).toEqual(['code'])
    const code = NODE_TRAITS.code.shadowRun
    expect(code.kind === 'refused' && code.reason).toMatch(/real outbound calls/)
  })

  it('a node is never both network and dispatch or storage, so the timeout floor has one answer', () => {
    expect(withTrait((t) => t.network && t.dispatchOrDb)).toEqual([])
  })

  it('names the six types the walker runs itself and the executor refuses', () => {
    expect(withTrait((t) => t.walkGraphOnly)).toEqual(['bid_group', 'buyer_click_check', 'buyer_click_send', 'buyer_select', 'parallel', 'parallel_end'])
  })

  it('bid_group and buyer_select synthesize attempt rows; only partner_bid and bid_group name partners in config', () => {
    // buyer_select names no partner: it sells to every buyer holding an enabled
    // profile priced for its population, which the partner routes resolve at
    // read time rather than from the node's config.
    expect(withTrait((t) => t.synthesizesAttempts)).toEqual(['bid_group', 'buyer_select'])
    expect(withTrait((t) => t.referencesPartners)).toEqual(['bid_group', 'buyer_click_check', 'buyer_click_send', 'partner_bid'])
  })

  it('static handles: the gate, the group and the buyer selection have fixed outgoing handles, everything else has none or derives them from config', () => {
    expect(NODE_TRAITS.filter.staticHandles).toEqual(['pass', 'exit'])
    expect(NODE_TRAITS.bid_group.staticHandles).toEqual(['winner', 'no_winner'])
    expect(NODE_TRAITS.buyer_select.staticHandles).toEqual(['sold', 'no_sale', 'not_applicable', 'deferred'])
    expect(NODE_TRAITS.buyer_click_check.staticHandles).toEqual(['eligible', 'not_eligible'])
    expect(NODE_TRAITS.buyer_click_send.staticHandles).toEqual(['sent', 'refused', 'unknown', 'already_sent', 'in_progress', 'needs_review', 'not_sent'])
    expect(withTrait((t) => t.staticHandles !== null)).toEqual(['bid_group', 'buyer_click_check', 'buyer_click_send', 'buyer_select', 'filter'])
  })

  it('maps each type to its executor file, in kebab case, or null for the walk only and inline types', () => {
    const files = Object.fromEntries(NODE_TYPES.map((t) => [t, NODE_TRAITS[t].executorFile]))
    expect(files).toEqual({
      achieve_offers: 'achieve-offers',
      bid_group: 'bid-group',
      branch: 'branch',
      branch_end: null,
      buyer_click_check: 'buyer-click-check',
      buyer_click_send: 'buyer-click-send',
      buyer_select: 'buyer-select',
      code: 'code',
      constants: 'constants',
      data_store: 'data-store',
      exit: null,
      filter: 'filter',
      latency_gate: 'latency-gate',
      parallel: 'parallel',
      parallel_end: null,
      partner_bid: 'partner-bid',
      response: 'response',
      salesforce: 'salesforce',
      transform: 'transform',
      webhook: 'integration',
    })
    for (const file of Object.values(files)) {
      if (file !== null) expect(file).toMatch(/^[a-z]+(-[a-z]+)*$/)
    }
  })
})

// #1707 (plan 0.C): every node type declares which workflow lanes may run it.
// The money only list is written out here, independently of the traits, so a
// trait flipped to shared by mistake turns this red rather than agreeing with
// itself (L70): these touch partner config, partner credentials, buyer ledgers
// or the bid matrix, and an ops workflow must never reach one.
const MONEY_ONLY = [
  'achieve_offers', 'bid_group', 'buyer_click_check', 'buyer_click_send', 'buyer_select', 'constants', 'data_store',
  'latency_gate', 'partner_bid', 'salesforce',
]

describe('lanes', () => {
  it('names the two workflow lanes', () => {
    expect([...WORKFLOW_LANES]).toEqual(['money', 'ops'])
    expect(isWorkflowLane('ops')).toBe(true)
    expect(isWorkflowLane('Money')).toBe(false)
    expect(isWorkflowLane(null)).toBe(false)
  })

  it('every node type declares a lane, money or shared', () => {
    for (const t of NODE_TYPES) expect(['money', 'shared']).toContain(NODE_TRAITS[t].lane)
  })

  it('marks exactly the money only types as money', () => {
    expect(withTrait((t) => t.lane === 'money')).toEqual(MONEY_ONLY)
  })

  it('a money workflow may run every node type', () => {
    expect([...nodeTypesForLane('money')].sort()).toEqual(SORTED)
  })

  it('an ops workflow may run no money only type', () => {
    const ops = nodeTypesForLane('ops')
    for (const t of MONEY_ONLY) expect(ops).not.toContain(t)
    expect([...ops].sort()).toEqual(SORTED.filter((t) => !MONEY_ONLY.includes(t)))
    expect(nodeTypeRunsInLane('partner_bid', 'ops')).toBe(false)
    expect(nodeTypeRunsInLane('code', 'ops')).toBe(true)
  })
})

describe('assertNever', () => {
  it('throws naming the value that reached it, so a definition carrying an unknown type fails loud (L11)', () => {
    expect(() => assertNever('mystery' as never, 'node type')).toThrow('Unhandled node type: mystery')
    expect(() => assertNever(undefined as never)).toThrow('Unhandled value: undefined')
  })
})
