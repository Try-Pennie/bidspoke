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
  'buyer_select',
  'buyer_click_send',
  'buyer_click_check',
] as const

export type NodeType = (typeof NODE_TYPES)[number]

const NODE_TYPE_SET: ReadonlySet<string> = new Set<string>(NODE_TYPES)

/** Narrows a value read from a definition or a step row to a node type. */
export function isNodeType(value: unknown): value is NodeType {
  return typeof value === 'string' && NODE_TYPE_SET.has(value)
}

/**
 * The lane a workflow runs in (#1707, plan 0.C). Money workflows sell leads and
 * run on the bidding Worker; ops workflows (internal tooling, texting, file
 * parsers moved off Pipedream) run on the ops Worker against their own database.
 */
export const WORKFLOW_LANES = ['money', 'ops'] as const
export type WorkflowLane = (typeof WORKFLOW_LANES)[number]

export function isWorkflowLane(value: unknown): value is WorkflowLane {
  return value === 'money' || value === 'ops'
}

/**
 * Which workflows may run a node type: `money` only in a money workflow,
 * `shared` in either. A node is money only when it reads partner config,
 * partner credentials, buyer ledgers or the bid matrix, or writes state money
 * flows share (the SUBMISSIONS store), so an ops workflow can never reach one.
 */
export type NodeLane = 'money' | 'shared'

export interface NodeTraits {
  /** Which workflow lanes may run it: required, so a new type has to decide. */
  lane: NodeLane
  /** Every run pays an outbound round trip plus TLS: the network timeout floor. */
  network: boolean
  /** A cold dispatch or storage round trip no retry can rescue: the dispatch floor. */
  dispatchOrDb: boolean
  /** walkGraph runs it itself; executeNode refuses it. */
  walkGraphOnly: boolean
  /** Writes one child step row per attempted partner, linked by parallel_group_id. */
  synthesizesAttempts: boolean
  /**
   * Records its own bid-attempt row(s) during the walk through makeBidLogger
   * (recordBidAttempt), so the strand projection (bidAttemptsForProjection)
   * deliberately omits it to avoid double counting a non-stranded run. This is
   * the #368 gap: a STRANDED run that bid through one of these loses its
   * per-attempt rows. A new node that writes bid rows natively MUST set this, so
   * the projection gap is reckoned with rather than joined silently (L96).
   * A superset of synthesizesAttempts: partner_bid records one attempt without
   * synthesizing children.
   */
  recordsBidAttempts: boolean
  /** Its config names partner ids, so a partner change has to find it. */
  referencesPartners: boolean
  /** Outgoing handle ids fixed by the type, or null when there are none or they come from config. */
  staticHandles: readonly string[] | null
  /** The executor's file name under engine/nodes, or null for the walk only and inline types. */
  executorFile: string | null
  /**
   * How a canvas test run differs for this node from a live run, or null when it
   * does not: a test run is otherwise live and makes its real calls (#1708).
   * `report_only` decides and records but commits nothing; `unscreened` skips
   * the pre-send screen. Read only through engine/run-reality.ts.
   */
  testRunException: { kind: 'report_only' | 'unscreened'; reason: string } | null
  /**
   * What a shadow run does with this node (#1780, #1708). A shadow run must
   * send nothing: `sends_nothing` makes no outside call or write anyway,
   * `stubbed` has its outbound call or write skipped by the run, and
   * `sandboxed` runs where every outside call is refused: a code node's scripts
   * run in the compare dispatch namespace, whose outbound Worker refuses every
   * request, and a shadow run with no compare bundle deployed is refused before
   * anything runs. Required, so a new type has to decide. Read only through
   * engine/run-reality.ts.
   */
  shadowRun: { kind: 'sends_nothing' | 'stubbed' | 'sandboxed' }
}

const SENDS_NOTHING = { kind: 'sends_nothing' } as const
const STUBBED = { kind: 'stubbed' } as const
const SANDBOXED = { kind: 'sandboxed' } as const

const inMemory = (over: Partial<NodeTraits> & Pick<NodeTraits, 'lane' | 'shadowRun'>): NodeTraits => ({
  network: false,
  dispatchOrDb: false,
  walkGraphOnly: false,
  synthesizesAttempts: false,
  recordsBidAttempts: false,
  referencesPartners: false,
  staticHandles: null,
  executorFile: null,
  testRunException: null,
  ...over,
})

export const NODE_TRAITS: Record<NodeType, NodeTraits> = {
  filter: inMemory({ lane: 'shared', shadowRun: SENDS_NOTHING, executorFile: 'filter', staticHandles: ['pass', 'exit'] }),
  branch: inMemory({ lane: 'shared', shadowRun: SENDS_NOTHING, executorFile: 'branch' }),
  branch_end: inMemory({ lane: 'shared', shadowRun: SENDS_NOTHING }),
  code: inMemory({
    lane: 'shared',
    dispatchOrDb: true,
    executorFile: 'code',
    // Its scripts make their real calls, which nothing inside a script can be
    // trusted to stub, so a shadow run dispatches them to the compare namespace (#1708).
    shadowRun: SANDBOXED,
  }),
  response: inMemory({ lane: 'shared', shadowRun: SENDS_NOTHING, executorFile: 'response' }),
  exit: inMemory({ lane: 'shared', shadowRun: SENDS_NOTHING }),
  parallel: inMemory({ lane: 'shared', shadowRun: SENDS_NOTHING, walkGraphOnly: true, executorFile: 'parallel' }),
  parallel_end: inMemory({ lane: 'shared', shadowRun: SENDS_NOTHING, walkGraphOnly: true }),
  partner_bid: inMemory({ lane: 'money', shadowRun: STUBBED, network: true, referencesPartners: true, recordsBidAttempts: true, executorFile: 'partner-bid' }),
  bid_group: inMemory({
    lane: 'money',
    // Each attempt runs through partner_bid, which the run stubs.
    shadowRun: STUBBED,
    network: true,
    walkGraphOnly: true,
    synthesizesAttempts: true,
    recordsBidAttempts: true,
    referencesPartners: true,
    staticHandles: ['winner', 'no_winner'],
    executorFile: 'bid-group',
  }),
  webhook: inMemory({ lane: 'shared', shadowRun: STUBBED, network: true, executorFile: 'integration' }),
  transform: inMemory({ lane: 'shared', shadowRun: SENDS_NOTHING, executorFile: 'transform' }),
  constants: inMemory({ lane: 'money', shadowRun: SENDS_NOTHING, dispatchOrDb: true, executorFile: 'constants' }),
  salesforce: inMemory({ lane: 'money', shadowRun: STUBBED, network: true, executorFile: 'salesforce' }),
  data_store: inMemory({ lane: 'money', shadowRun: STUBBED, dispatchOrDb: true, executorFile: 'data-store' }),
  latency_gate: inMemory({ lane: 'money', shadowRun: STUBBED, dispatchOrDb: true, referencesPartners: true, executorFile: 'latency-gate' }),
  achieve_offers: inMemory({
    lane: 'money',
    shadowRun: STUBBED,
    network: true,
    executorFile: 'achieve-offers',
    testRunException: {
      kind: 'unscreened',
      reason: 'The score floor doubles as the live pipe pause switch, and a canvas test send is one deliberate lead, so it goes out regardless (Dan, 2026-08-31).',
    },
  }),
  // Sells a lead to the highest ranked eligible buyer (#1411). Walker only,
  // because it writes one attempt row per buyer tried; names no partner in its
  // config, since the buyers are whoever holds an enabled profile priced for its
  // population, which the partner routes resolve at read time.
  buyer_select: inMemory({
    lane: 'money',
    shadowRun: STUBBED,
    network: true,
    walkGraphOnly: true,
    synthesizesAttempts: true,
    recordsBidAttempts: true,
    staticHandles: ['sold', 'no_sale', 'not_applicable', 'deferred'],
    executorFile: 'buyer-select',
    testRunException: { kind: 'report_only', reason: 'A test run must not sell a lead, spend a buyer cap or write a sale.' },
  }),
  // Claims, posts and counts one click for a click sold buyer (#1542). Walker
  // only, because a retried send is a duplicate: it runs exactly once and
  // refuses a resumed or replayed execution. It names its partner by id in
  // `partner_id` (#1553), so the partner finder reads it like partner_bid.
  buyer_click_send: inMemory({
    lane: 'money',
    shadowRun: STUBBED,
    network: true,
    walkGraphOnly: true,
    referencesPartners: true,
    staticHandles: ['sent', 'refused', 'unknown', 'already_sent', 'in_progress', 'needs_review', 'not_sent'],
    executorFile: 'buyer-click-send',
    testRunException: { kind: 'report_only', reason: 'A test run must not post a click or count it against the buyer cap.' },
  }),
  // Decides on Engine's response path whether a click sold buyer may be offered
  // this lead (#1543): the buyer profile's box, judged when the node runs, then
  // today's distinct click count against the profile's daily cap. Its reads are
  // a KV or database load and one Durable Object round trip, so it takes the
  // dispatch floor, not the network one. Walker only, like buyer_click_send, so
  // its own 300 ms budget is the only bound and no retry loop repeats it. It
  // names its partner by id in `partner_id`.
  buyer_click_check: inMemory({
    lane: 'money',
    shadowRun: SENDS_NOTHING,
    dispatchOrDb: true,
    walkGraphOnly: true,
    referencesPartners: true,
    staticHandles: ['eligible', 'not_eligible'],
    executorFile: 'buyer-click-check',
  }),
}

const NODE_TYPES_BY_LANE: Record<WorkflowLane, readonly NodeType[]> = {
  money: NODE_TYPES.filter((t) => NODE_TRAITS[t].lane === 'money' || NODE_TRAITS[t].lane === 'shared'),
  ops: NODE_TYPES.filter((t) => NODE_TRAITS[t].lane === 'shared'),
}

/** The node types a workflow in this lane may carry. */
export function nodeTypesForLane(lane: WorkflowLane): readonly NodeType[] {
  return NODE_TYPES_BY_LANE[lane]
}

export function nodeTypeRunsInLane(type: NodeType, lane: WorkflowLane): boolean {
  return NODE_TYPES_BY_LANE[lane].includes(type)
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
