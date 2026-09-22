/**
 * @bidspoke/node-types (#1411, milestone 52): the one list of node types a saved
 * workflow definition can carry, the type derived from it, and the traits each
 * type has. Both apps re-export NODE_TYPES and NodeType from here, so the worker
 * union and the web array cannot drift, and every switch, record and set keyed
 * by a node type reads a trait or ends in assertNever (L247, L96).
 *
 * Not listed, on purpose: `trigger` (a canvas node, never a saved node type),
 * `region` (a grouping frame), and `integration` (a spelling no live definition
 * carries; the canvas type for an outbound HTTP call is `webhook`).
 */

export const NODE_TYPES = [
  'filter',
  'branch',
  'branch_end',
  'code',
  'response',
  'exit',
  'parallel',
  'parallel_end',
  'partner_bid',
  'bid_group',
  'webhook',
  'transform',
  'constants',
  'salesforce',
  'data_store',
  'latency_gate',
  'achieve_offers',
] as const

export type NodeType = (typeof NODE_TYPES)[number]

const NODE_TYPE_SET: ReadonlySet<string> = new Set<string>(NODE_TYPES)

/** Narrows a value read from a definition or a step row to a node type. */
export function isNodeType(value: unknown): value is NodeType {
  return typeof value === 'string' && NODE_TYPE_SET.has(value)
}

export interface NodeTraits {
  /** Every run pays an outbound round trip plus TLS: the network timeout floor. */
  network: boolean
  /** A cold dispatch or storage round trip no retry can rescue: the dispatch floor. */
  dispatchOrDb: boolean
  /** walkGraph runs it itself; executeNode refuses it. */
  walkGraphOnly: boolean
  /** Writes one child step row per attempted partner, linked by parallel_group_id. */
  synthesizesAttempts: boolean
  /** Its config names partner ids, so a partner change has to find it. */
  referencesPartners: boolean
  /** Outgoing handle ids fixed by the type, or null when there are none or they come from config. */
  staticHandles: readonly string[] | null
  /** The executor's file name under engine/nodes, or null for the walk only and inline types. */
  executorFile: string | null
}

const inMemory = (over: Partial<NodeTraits> = {}): NodeTraits => ({
  network: false,
  dispatchOrDb: false,
  walkGraphOnly: false,
  synthesizesAttempts: false,
  referencesPartners: false,
  staticHandles: null,
  executorFile: null,
  ...over,
})

export const NODE_TRAITS: Record<NodeType, NodeTraits> = {
  filter: inMemory({ executorFile: 'filter', staticHandles: ['pass', 'exit'] }),
  branch: inMemory({ executorFile: 'branch' }),
  branch_end: inMemory(),
  code: inMemory({ dispatchOrDb: true, executorFile: 'code' }),
  response: inMemory({ executorFile: 'response' }),
  exit: inMemory(),
  parallel: inMemory({ walkGraphOnly: true, executorFile: 'parallel' }),
  parallel_end: inMemory({ walkGraphOnly: true }),
  partner_bid: inMemory({ network: true, referencesPartners: true, executorFile: 'partner-bid' }),
  bid_group: inMemory({
    network: true,
    walkGraphOnly: true,
    synthesizesAttempts: true,
    referencesPartners: true,
    staticHandles: ['winner', 'no_winner'],
    executorFile: 'bid-group',
  }),
  webhook: inMemory({ network: true, executorFile: 'integration' }),
  transform: inMemory({ executorFile: 'transform' }),
  constants: inMemory({ dispatchOrDb: true, executorFile: 'constants' }),
  salesforce: inMemory({ network: true, executorFile: 'salesforce' }),
  data_store: inMemory({ dispatchOrDb: true, executorFile: 'data-store' }),
  latency_gate: inMemory({ dispatchOrDb: true, executorFile: 'latency-gate' }),
  achieve_offers: inMemory({ network: true, executorFile: 'achieve-offers' }),
}

/**
 * The end of every switch over a node type. Unreachable when the switch is
 * exhaustive, which the `never` parameter makes the compiler check; reached at
 * runtime only by a definition carrying a type this build has never heard of,
 * which fails loud rather than falling through to a default (L11).
 */
export function assertNever(value: never, what = 'value'): never {
  throw new Error(`Unhandled ${what}: ${String(value)}`)
}
