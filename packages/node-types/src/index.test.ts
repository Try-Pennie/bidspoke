/**
 * @bidspoke/node-types: the one list of node types a saved definition can
 * carry, and the traits each one has (#1411, milestone 52). Both apps re-export
 * it, so a type added here reaches every switch, record and set that must know
 * about it, and a switch that forgets one is a compile error at assertNever.
 */
import { describe, expect, it } from 'vitest'
import { NODE_TRAITS, NODE_TYPES, assertNever, isNodeType, type NodeType } from './index'

const SORTED = [
  'achieve_offers', 'bid_group', 'branch', 'branch_end', 'buyer_select', 'code', 'constants', 'data_store', 'exit', 'filter',
  'latency_gate', 'parallel', 'parallel_end', 'partner_bid', 'response', 'salesforce', 'transform', 'webhook',
]

const withTrait = (pick: (t: (typeof NODE_TRAITS)[NodeType]) => boolean): string[] =>
  NODE_TYPES.filter((t) => pick(NODE_TRAITS[t])).sort()

describe('NODE_TYPES', () => {
  it('lists the eighteen node types a saved definition can carry, once each', () => {
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
    expect(withTrait((t) => t.network)).toEqual(['achieve_offers', 'bid_group', 'buyer_select', 'partner_bid', 'salesforce', 'webhook'])
  })

  it('names the dispatch or storage nodes: a cold path no retry can rescue', () => {
    expect(withTrait((t) => t.dispatchOrDb)).toEqual(['code', 'constants', 'data_store', 'latency_gate'])
  })

  it('a node is never both network and dispatch or storage, so the timeout floor has one answer', () => {
    expect(withTrait((t) => t.network && t.dispatchOrDb)).toEqual([])
  })

  it('names the four types the walker runs itself and the executor refuses', () => {
    expect(withTrait((t) => t.walkGraphOnly)).toEqual(['bid_group', 'buyer_select', 'parallel', 'parallel_end'])
  })

  it('bid_group and buyer_select synthesize attempt rows; only partner_bid and bid_group name partners in config', () => {
    // buyer_select names no partner: it sells to every buyer holding an enabled
    // profile priced for its population, which the partner routes resolve at
    // read time rather than from the node's config.
    expect(withTrait((t) => t.synthesizesAttempts)).toEqual(['bid_group', 'buyer_select'])
    expect(withTrait((t) => t.referencesPartners)).toEqual(['bid_group', 'partner_bid'])
  })

  it('static handles: the gate, the group and the buyer selection have fixed outgoing handles, everything else has none or derives them from config', () => {
    expect(NODE_TRAITS.filter.staticHandles).toEqual(['pass', 'exit'])
    expect(NODE_TRAITS.bid_group.staticHandles).toEqual(['winner', 'no_winner'])
    expect(NODE_TRAITS.buyer_select.staticHandles).toEqual(['sold', 'no_sale', 'not_applicable', 'deferred'])
    expect(withTrait((t) => t.staticHandles !== null)).toEqual(['bid_group', 'buyer_select', 'filter'])
  })

  it('maps each type to its executor file, in kebab case, or null for the walk only and inline types', () => {
    const files = Object.fromEntries(NODE_TYPES.map((t) => [t, NODE_TRAITS[t].executorFile]))
    expect(files).toEqual({
      achieve_offers: 'achieve-offers',
      bid_group: 'bid-group',
      branch: 'branch',
      branch_end: null,
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

describe('assertNever', () => {
  it('throws naming the value that reached it, so a definition carrying an unknown type fails loud (L11)', () => {
    expect(() => assertNever('mystery' as never, 'node type')).toThrow('Unhandled node type: mystery')
    expect(() => assertNever(undefined as never)).toThrow('Unhandled value: undefined')
  })
})
