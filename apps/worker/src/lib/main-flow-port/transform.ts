/**
 * The Main Flow relay port as a transform (#2171, phase 2 of #1680).
 *
 * Main Flow (`60e2e0bc`) is edited on the canvas by Brian and Dan, so no copy of
 * it is kept in the repo. Instead, every change the port makes is this one pure
 * function, applied to whatever the live canvas holds at the moment of the apply
 * (apply.ts) and to the production fixture in the tests. It:
 *
 *  - turns each of the nine outcome posts to Pipedream's Update Submission relay
 *    into a native Salesforce `update` of `Submission__c` under the SAME
 *    namespace (so `success_node_namespaces` still counts it), keeping its body
 *    template exactly: a JSON text body stays text and is rendered then parsed, a
 *    code node's `sfBody` is sent as the object it is. `omit_fields` drops the two
 *    keys the relay never sent (`executionId`, `submissionId`), `rename_fields`
 *    makes the relay's two renames, the record id is the body's own
 *    `submissionId` (where the relay read it), `skip_when_empty` reproduces the
 *    relay's filter, and `injected_fields` adds `PDFlow_4__c`, the Bidspoke run
 *    link (decision D4), which the inquiry relay wrote before;
 *  - optionally moves the inquiry post after the answer: `send_salesforce_inquiry`
 *    leaves `parallel_1`, and every outcome write is followed by a parallel block
 *    (`credit_posts_<post>`) whose first slot is a small code node building the
 *    `credit-inquiries` body and the Apex call itself, `retries: 0` (a resend
 *    attaches a second file to the Lead), skipped when the body is null. The code
 *    node returns null unless the lead took `equifax_debt`'s `trades_present`
 *    route, the only place the inquiry post runs today, and its report carries
 *    inquiries (#2169: the endpoint writes nothing for an empty list and answers
 *    500 without one). A failed inquiry call fails the block and ends the walk;
 *  - optionally adds the collections post (#2832) as the block's second slot, the
 *    same pair for `credit-collections`, run beside the inquiry pair so the two
 *    calls never add up inside the 12 s after the answer. Its slot is marked
 *    `on_failure: 'continue'`: a failed collections call is recorded and alerted
 *    by the engine but never stops the walk (Achieve still runs).
 *
 * It refuses, by name and naming every problem at once, any definition whose
 * parts it rewrites are not the shape it was written against: a post missing or
 * changed, a tenth post to either relay, `parallel_1` or the inquiry relay
 * changed, a step that reads what a relay post answered. A canvas edit there then
 * stops the apply instead of being guessed at.
 *
 * Stages (PORT_STAGES) follow the plan's phases 4 to 7, and each is idempotent: a
 * post already ported is recognised and left alone, so a stage can be applied
 * over the one before it.
 *
 * No runtime import: apply.ts and this file are also bundled into the script run
 * in Dan's logged in tab (scripts/main-flow-port-tab.ts).
 */

export const MAIN_FLOW_WORKFLOW_ID = '60e2e0bc-5aa2-47db-b333-3a8fe1c62e09'

export interface DefNode {
  id: string
  namespace: string
  label?: string
  type: string
  position?: { x: number; y: number }
  config: Record<string, unknown>
  variables?: Record<string, string>
}

export interface DefEdge {
  id: string
  source: string
  target: string
  source_handle?: string
}

export interface Definition {
  trigger?: unknown
  nodes: DefNode[]
  edges: DefEdge[]
}

/** The nine outcome posts to the Update Submission relay, in the order the trigger's success list names them. */
export const OUTCOME_POSTS = [
  'tripoint_sf_post',
  'amone_sf_post',
  'send_salesforce',
  'send_fallback_salesforce',
  'send_fallback_salesforce_1',
  'engine_no_bids_sf_post',
  'under_10000_sf_post',
  'invalid_state_sf_post',
  'debt_missing_sf_post',
] as const
export type OutcomePost = (typeof OUTCOME_POSTS)[number]

export const INQUIRY_RELAY_POST = 'send_salesforce_inquiry'
const PARALLEL = 'parallel_1'
const PARALLEL_END = 'parallel_end_1'
const TRADES_BRANCH = 'equifax_debt'
const TRADES_ROUTE = 'trades_present'

export interface PortOptions {
  /** Which outcome posts to port; posts already ported stay as they are either way. */
  posts: 'all' | readonly OutcomePost[]
  /** Move the inquiry post after the answer. Needs every outcome post ported. */
  moveInquiry: boolean
  /**
   * Add the collections post beside the inquiry post (#2832). It rides in the
   * inquiry's block after each outcome write, so it needs `moveInquiry`. A stage
   * without it leaves collections steps already there alone.
   */
  collections?: boolean
}

/**
 * The plan's phases 4 to 7, then the collections post (#2832), each applied over
 * the one before. `collections` is built but not applied: it is turned on when
 * the Salesforce endpoint exists.
 */
export const PORT_STAGES = {
  canary_invalid_state: { posts: ['invalid_state_sf_post'], moveInquiry: false },
  canary_send_salesforce: { posts: ['invalid_state_sf_post', 'send_salesforce'], moveInquiry: false },
  outcome_posts: { posts: 'all', moveInquiry: false },
  inquiry: { posts: 'all', moveInquiry: true },
  collections: { posts: 'all', moveInquiry: true, collections: true },
} as const satisfies Record<string, PortOptions>
export type PortStage = keyof typeof PORT_STAGES

/**
 * Per attempt timeouts, chosen so the worst case after the answer fits the 12 s
 * the run waits for its walk (CONTINUATION_WINDOW_MS, lib/post-response-budget.ts),
 * which a definition test proves for every branch.
 *
 * The completing outcome PATCH gets ONE attempt of 4.5 s rather than retries
 * (#1680 plan amendment 3): two attempts at the p99.9 of the same object's
 * lighter PATCH already take about 9 s. 4.5 s is that p99.9 over 7 days
 * (`set_completed_submission`, 4,474 ms, 23,318 attempts); over the 3 days to
 * 2026-10-15 its p99 was 1,887 ms and p99.9 7,077 ms (10,332 attempts). Counted
 * against 4.5 s directly: 25 of 23,364 single attempts in the 7 days took longer
 * (about 1 in 935), 22 of them in the last 3 days (about 1 in 470), so expect one
 * or two outcome writes in 1,000 to time out, more if the completing write is
 * slower than this lighter one (inferred, not measured). A timed out write may
 * still have landed; it is recorded by the at-risk watch for #2023's read-back
 * rather than resent here.
 *
 * The Apex call gets one attempt of 4.5 s, sized on the closest call we measure,
 * the same org's `credit-trades` Apex REST step (`trades_request`, p50 2,014 ms,
 * p99 4,001 ms over 9,771 attempts in the same 3 days). The body code node gets
 * 500 ms, one attempt (its sibling code nodes take under 60 ms at the maximum).
 *
 * The collections pair (#2832) gets the same: the endpoint is built like
 * `credit-trades`, so the same 4.5 s. It also gets ONE attempt, but for a
 * different reason from the inquiry post: a repeat call is harmless (each call
 * replaces the Lead's collection rows, and Geoff accepts the extra file a repeat
 * attaches, as with trades), so it could be retried, but a retry does not fit the
 * 12 s after the answer. It runs beside the inquiry pair in one block, so the
 * block costs the longer of the two, never their sum.
 *
 * The block waits at most CREDIT_POSTS_TIMEOUT_MS: the longest slot (body and
 * Apex call, 5 s) plus 500 ms, so each call ends on its own deadline, recorded
 * as what it did, before the block stops waiting.
 */
export const OUTCOME_WRITE_TIMEOUT_MS = 4_500
export const INQUIRY_APEX_TIMEOUT_MS = 4_500
export const INQUIRY_BODY_TIMEOUT_MS = 500
export const COLLECTIONS_APEX_TIMEOUT_MS = 4_500
export const COLLECTIONS_BODY_TIMEOUT_MS = 500
export const CREDIT_POSTS_TIMEOUT_MS = Math.max(INQUIRY_BODY_TIMEOUT_MS + INQUIRY_APEX_TIMEOUT_MS, COLLECTIONS_BODY_TIMEOUT_MS + COLLECTIONS_APEX_TIMEOUT_MS) + 500

export const INQUIRY_APEX_PATH = '/services/apexrest/credit-inquiries'
/** CollectionParserRest in the Pennie org (#2832), not live yet. */
export const COLLECTIONS_APEX_PATH = '/services/apexrest/credit-collections'

/** The relay's own drop and renames (docs/salesforce-post-answer-write-contract.md, question 1). */
export const RELAY_OMITTED_KEYS = ['executionId', 'submissionId'] as const
export const RELAY_RENAMES = { UUID: 'Engine_UUID_SO__c', leadUUID: 'Engine_Lead_UUID_SO__c' } as const

/**
 * Builds the credit-inquiries body after an outcome write, or null so the Apex
 * call is skipped. Mirrors the relay's own body step (contract doc, question 1):
 * `{ submissionId, inquiriesJson }`, the inquiries with null valued keys dropped,
 * written the way `trades_body` builds the trades call.
 */
export const INQUIRY_BODY_SCRIPT = [
  '// The credit-inquiries Apex body after this branch\'s outcome write (#1680).',
  '// Null skips the call: only leads that took equifax_debt\'s trades_present route',
  '// posted inquiries before the port, and the endpoint writes nothing for an empty',
  '// list and answers 500 when the list is missing (#2169).',
  'if (steps.equifax_debt?.output?._route !== \'trades_present\') return null;',
  'const report = steps.equifax_credit_report?.output?.data?.consumers?.equifaxUSConsumerCreditReport?.[0];',
  'const inquiries = Array.isArray(report?.inquiries) ? report.inquiries.filter((i) => i && typeof i === \'object\') : [];',
  'if (inquiries.length === 0 || !payload.Submission__c) return null;',
  '',
  'const removeNullValues = (obj) => Object.fromEntries(',
  '  Object.entries(obj).filter(([_, value]) => value !== null)',
  ');',
  '',
  'return {',
  '  submissionId: payload.Submission__c,',
  '  inquiriesJson: JSON.stringify({ inquiries: inquiries.map(removeNullValues) }),',
  '};',
].join('\n')

export const inquiryBodyNamespace = (post: OutcomePost): string => `inquiry_body_${post}`
export const inquiryApexNamespace = (post: OutcomePost): string => `inquiry_apex_${post}`

/**
 * Builds the credit-collections Apex body after an outcome write, or null so the
 * Apex call is skipped (#2832). The same shape as `trades_body`'s:
 * `{ submissionId, collectionsJson }`, the collections as JSON text.
 */
export const COLLECTIONS_BODY_SCRIPT = [
  '// The credit-collections Apex body after this branch\'s outcome write (#2832).',
  '// Null skips the call: only leads that took equifax_debt\'s trades_present route',
  '// have their credit report posted, as the inquiries are.',
  'if (steps.equifax_debt?.output?._route !== \'trades_present\') return null;',
  'if (!payload.Submission__c) return null;',
  'const report = steps.equifax_credit_report?.output?.data?.consumers?.equifaxUSConsumerCreditReport?.[0];',
  '// Provisional, pending the spec answer on #2832: a report with no collections key',
  '// sends nothing, and an empty list is sent, which the endpoint reads as none now.',
  'if (report?.collections === undefined || report?.collections === null) return null;',
  '',
  '// Every field of every item goes as Equifax sent it (Geoff, #2832). Only null',
  '// valued keys are dropped, exactly as trades_body does for the trades: a null',
  '// carries nothing.',
  'const removeNullValues = (obj) => Object.fromEntries(',
  '  Object.entries(obj).filter(([_, value]) => value !== null)',
  ');',
  '',
  'return {',
  '  submissionId: payload.Submission__c,',
  '  collectionsJson: JSON.stringify({ collections: report.collections.map(removeNullValues) }),',
  '};',
].join('\n')

export const collectionsBodyNamespace = (post: OutcomePost): string => `collections_body_${post}`
export const collectionsApexNamespace = (post: OutcomePost): string => `collections_apex_${post}`
/** The parallel block after an outcome write that runs the credit posts side by side (#2832), and its join. */
export const creditPostsNamespace = (post: OutcomePost): string => `credit_posts_${post}`
export const creditPostsEndNamespace = (post: OutcomePost): string => `credit_posts_end_${post}`

/**
 * One credit post after each outcome write: a body code node and the Apex call
 * that sends what it built, as one slot of the block. The inquiry post and the
 * collections post are two of these, built and recognised by the same code.
 */
interface CreditPost {
  slot: 'child-0' | 'child-1'
  slotLabel: string
  /** `continue`: the slot's failure is recorded and alerted but never fails the block (#2832). */
  onFailure?: 'continue'
  bodyNamespace: (post: OutcomePost) => string
  apexNamespace: (post: OutcomePost) => string
  bodyLabel: string
  apexLabel: string
  script: string
  apexPath: string
  bodyTimeoutMs: number
  apexTimeoutMs: number
  /** Where its two steps sit on the canvas, right of the write. */
  column: number
}

const INQUIRY_POST: CreditPost = {
  slot: 'child-0',
  slotLabel: 'inquiry',
  bodyNamespace: inquiryBodyNamespace,
  apexNamespace: inquiryApexNamespace,
  bodyLabel: 'Inquiry Body after',
  apexLabel: 'Credit Inquiries after',
  script: INQUIRY_BODY_SCRIPT,
  apexPath: INQUIRY_APEX_PATH,
  bodyTimeoutMs: INQUIRY_BODY_TIMEOUT_MS,
  apexTimeoutMs: INQUIRY_APEX_TIMEOUT_MS,
  column: 152,
}

const COLLECTIONS_POST: CreditPost = {
  slot: 'child-1',
  slotLabel: 'collections',
  onFailure: 'continue',
  bodyNamespace: collectionsBodyNamespace,
  apexNamespace: collectionsApexNamespace,
  bodyLabel: 'Collections Body after',
  apexLabel: 'Credit Collections after',
  script: COLLECTIONS_BODY_SCRIPT,
  apexPath: COLLECTIONS_APEX_PATH,
  bodyTimeoutMs: COLLECTIONS_BODY_TIMEOUT_MS,
  apexTimeoutMs: COLLECTIONS_APEX_TIMEOUT_MS,
  column: 304,
}

const CREDIT_POSTS = [INQUIRY_POST, COLLECTIONS_POST]

/** The block's settings for the credit posts it holds, in slot order. */
function creditPostsConfig(held: readonly CreditPost[]): Record<string, unknown> {
  return {
    wait_for: 'all',
    // An unmarked slot (the inquiry post) failing fails the block, so the walk ends
    // as it did when the inquiry call ran in the walk itself (#2171).
    on_child_error: 'fail',
    on_timeout: 'partial',
    timeout_ms: CREDIT_POSTS_TIMEOUT_MS,
    children: held.map((c) => ({ id: c.slot, label: c.slotLabel, ...(c.onFailure ? { on_failure: c.onFailure } : {}) })),
  }
}

/** The Apex call of a credit post. One attempt each; why, per post, is said at the timeouts above. */
function creditApexConfig(c: CreditPost, post: OutcomePost): Record<string, unknown> {
  return {
    operation: 'apex',
    apex_path: c.apexPath,
    body: `{{steps.${c.bodyNamespace(post)}.output}}`,
    skip_when_empty: true,
    retries: 0,
    timeout_ms: c.apexTimeoutMs,
  }
}

/** Thrown with every reason the definition is not the shape the port was written against. */
export class MainFlowPortRefusal extends Error {
  readonly reasons: string[]
  // No parameter property: the tab bundle strips types without transforming code.
  constructor(reasons: string[]) {
    super(`The Main Flow port refused this definition:\n- ${reasons.join('\n- ')}`)
    this.reasons = reasons
    this.name = 'MainFlowPortRefusal'
  }
}

const RELAY_POST_KEYS = new Set(['url', 'body', 'retries', 'timeout_ms', 'service_label'])

/** The inquiry relay's body, as the contract records it. Anything else is a change the port was not written for. */
const INQUIRY_RELAY_BODY = {
  equifax: {
    models: '{{steps.equifax_credit_report.output.data.consumers.equifaxUSConsumerCreditReport[0].models}}',
    inquiries: '{{steps.equifax_credit_report.output.data.consumers.equifaxUSConsumerCreditReport[0].inquiries}}',
  },
  traceId: '{{execution.trace_id}}',
  submissionId: '{{trigger.payload.Submission__c}}',
}

const PARALLEL_CHILDREN_BEFORE = [
  { id: 'child-0', label: 'pennie_debt_calc' },
  { id: 'child-1', label: INQUIRY_RELAY_POST },
]
const PARALLEL_CHILDREN_AFTER = [PARALLEL_CHILDREN_BEFORE[0]]

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Key order independent equality of JSON values. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]))
  }
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) if (!sameJson(a[k], b[k])) return false
    return true
  }
  return Object.is(a, b)
}

const TEMPLATE_PATH = /^[A-Za-z_][\w.]*(?:\[\d+\][\w.]*)*$/

/**
 * The record id template for a body template: the body's own submissionId. For a
 * text body that is the template its "submissionId" key holds; for a reference to
 * a code node's object it is the same reference's `.submissionId`, a `??`
 * fallback kept as one. Null when the body has neither shape.
 */
export function recordIdTemplateFor(body: unknown): string | null {
  if (typeof body !== 'string') return null
  const whole = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(body)
  if (whole) {
    const parts = whole[1].split('??').map((p) => p.trim())
    if (parts.length === 0 || !parts.every((p) => TEMPLATE_PATH.test(p))) return null
    return `{{${parts.map((p) => `${p}.submissionId`).join(' ?? ')}}}`
  }
  const keyed = /"submissionId"\s*:\s*"(\{\{[^{}]+\}\})"/.exec(body)
  return keyed ? keyed[1] : null
}

/** The outcome deciding settings of a ported post, the part `isPortedPost` judges. */
function portedDecidingConfig(body: unknown, recordId: string): Record<string, unknown> {
  return {
    operation: 'update',
    object: 'Submission__c',
    record_id: recordId,
    body,
    omit_fields: [...RELAY_OMITTED_KEYS],
    rename_fields: { ...RELAY_RENAMES },
    injected_fields: { PDFlow_4__c: '{{execution.bidspoke_link}}' },
    skip_when_empty: true,
  }
}

function portedPostConfig(body: unknown, recordId: string): Record<string, unknown> {
  return {
    ...portedDecidingConfig(body, recordId),
    retries: 0,
    timeout_ms: OUTCOME_WRITE_TIMEOUT_MS,
    // A copy of set_completed_submission's, the native write to the same object
    // this config starts from (#1680 plan point 6).
    transient_errors: [{ code: 'REQUEST_LIMIT_EXCEEDED', message_contains: 'Concurrent' }],
  }
}

/** A post already ported: its deciding settings are this transform's. Retry tuning made on the canvas since is kept. */
function isPortedPost(node: DefNode): boolean {
  if (node.type !== 'salesforce') return false
  const recordId = recordIdTemplateFor(node.config.body)
  if (recordId === null) return false
  const expected = portedDecidingConfig(node.config.body, recordId)
  return Object.keys(expected).every((k) => sameJson(node.config[k], expected[k]))
}

/**
 * Which posts are ported, whether the inquiry has moved, and whether the
 * collections post follows every outcome write. Judged, not assumed: a post in
 * neither form is in neither list.
 */
export function portStatus(definition: Definition): { ported: OutcomePost[]; relay: OutcomePost[]; inquiryMoved: boolean; collections: boolean } {
  const ported: OutcomePost[] = []
  const relay: OutcomePost[] = []
  for (const post of OUTCOME_POSTS) {
    const node = definition.nodes.find((n) => n.namespace === post)
    if (!node) continue
    if (node.type === 'webhook') relay.push(post)
    else if (isPortedPost(node)) ported.push(post)
  }
  const inquiryMoved =
    !definition.nodes.some((n) => n.namespace === INQUIRY_RELAY_POST) &&
    OUTCOME_POSTS.every((p) => definition.nodes.some((n) => n.namespace === inquiryApexNamespace(p)))
  const collections = OUTCOME_POSTS.every((p) => definition.nodes.some((n) => n.namespace === collectionsApexNamespace(p)))
  return { ported, relay, inquiryMoved, collections }
}

/** The credit posts block after one outcome write, as found, with the posts it holds. */
interface CreditPostsBlock {
  block: DefNode
  end: DefNode
  held: CreditPost[]
}

/**
 * Reads the block after an outcome write, or says what is not the shape the port
 * builds: the write leads to the block alone, each slot it holds runs its body
 * then its Apex call into the block's join, the join leads on to one step, and
 * the block's settings are the port's for exactly the posts it holds.
 */
function readCreditPostsBlock(def: Definition, post: OutcomePost, write: DefNode): CreditPostsBlock | string[] {
  const reasons: string[] = []
  const byId = new Map(def.nodes.map((n) => [n.id, n]))
  const outOf = (id: string) => def.edges.filter((e) => e.source === id)
  const after = outOf(write.id)
  const block = after.length === 1 ? byId.get(after[0].target) : undefined
  if (!block || block.type !== 'parallel' || block.namespace !== creditPostsNamespace(post)) {
    return [`${post}: ${INQUIRY_RELAY_POST} is gone but ${creditPostsNamespace(post)} does not follow this post alone`]
  }
  const end = outOf(block.id).filter((e) => e.source_handle === 'output').map((e) => byId.get(e.target))[0]
  if (!end || end.type !== 'parallel_end' || end.namespace !== creditPostsEndNamespace(post)) {
    return [`${block.namespace}: does not lead to its join ${creditPostsEndNamespace(post)}`]
  }
  const held: CreditPost[] = []
  for (const c of CREDIT_POSTS) {
    const slot = outOf(block.id).filter((e) => e.source_handle === c.slot)
    if (slot.length === 0) continue
    const body = byId.get(slot[0].target)
    const toApex = body ? outOf(body.id) : []
    const apex = toApex.length === 1 ? byId.get(toApex[0].target) : undefined
    const toEnd = apex ? outOf(apex.id) : []
    const chain = slot.length === 1 && body?.namespace === c.bodyNamespace(post) && apex?.namespace === c.apexNamespace(post) && toEnd.length === 1 && toEnd[0].target === end.id
    if (!chain) reasons.push(`${block.namespace}: its ${c.slot} slot is not ${c.bodyNamespace(post)} then ${c.apexNamespace(post)} into ${end.namespace}`)
    else held.push(c)
  }
  if (!held.includes(INQUIRY_POST)) reasons.push(`${block.namespace}: does not hold the inquiry post`)
  if (outOf(block.id).length !== held.length + 1) reasons.push(`${block.namespace}: has ${outOf(block.id).length} edges out, not its join and one per credit post`)
  if (outOf(end.id).length !== 1) reasons.push(`${end.namespace}: has ${outOf(end.id).length} steps after it, not one`)
  if (!sameJson(block.config, creditPostsConfig(held))) reasons.push(`${block.namespace}: its settings are no longer the ones the port sets`)
  return reasons.length > 0 ? reasons : { block, end, held }
}

/** A stable id for a node or edge the transform adds, so the same input always gives the same output. */
function stableId(seed: string): string {
  const words: string[] = []
  for (let round = 0; round < 4; round++) {
    let h = 0x811c9dc5 ^ round
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    words.push(h.toString(16).padStart(8, '0'))
  }
  const hex = words.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

const hostOf = (url: unknown): string | null => {
  if (typeof url !== 'string') return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

const isPipedreamRelay = (url: unknown): boolean => (hostOf(url) ?? '').endsWith('.m.pipedream.net')

/** True when any template in `value` reads `steps.<namespace>` (a whole word, so `send_salesforce` never matches `send_salesforce_inquiry`). */
function readsStep(value: unknown, namespace: string): boolean {
  return new RegExp(`steps\\.${namespace}(?![\\w])`).test(JSON.stringify(value ?? null))
}

export function portMainFlow(input: unknown, options: PortOptions): Definition {
  if (!isObject(input)) throw new MainFlowPortRefusal(['the input is not a workflow definition object'])
  if (!Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    throw new MainFlowPortRefusal(['the definition has no nodes and edges lists'])
  }
  const def = structuredClone(input) as unknown as Definition
  const reasons: string[] = []
  const byNamespace = new Map<string, DefNode[]>()
  for (const n of def.nodes) byNamespace.set(n.namespace, [...(byNamespace.get(n.namespace) ?? []), n])
  const one = (ns: string): DefNode | null => {
    const found = byNamespace.get(ns) ?? []
    if (found.length === 1) return found[0]
    reasons.push(found.length === 0 ? `${ns}: no node with this namespace` : `${ns}: ${found.length} nodes share this namespace`)
    return null
  }
  const byId = new Map(def.nodes.map((n) => [n.id, n]))
  const outOf = (id: string) => def.edges.filter((e) => e.source === id)
  const into = (id: string) => def.edges.filter((e) => e.target === id)
  /** Back from `id` along single incoming edges: true when a response node is met, so the step runs after the answer. */
  const followsAnswer = (id: string): boolean => {
    let at = id
    for (let hop = 0; hop < def.nodes.length; hop++) {
      const incoming = into(at)
      if (incoming.length !== 1) return false
      const source = byId.get(incoming[0].source)
      if (!source) return false
      if (source.type === 'response') return true
      at = source.id
    }
    return false
  }

  const selected = new Set<OutcomePost>(options.posts === 'all' ? OUTCOME_POSTS : options.posts)

  // ── The nine posts: each the relay post or its port, after a response, with one step after it ──
  const posts = new Map<OutcomePost, DefNode>()
  for (const post of OUTCOME_POSTS) {
    const node = one(post)
    if (!node) continue
    posts.set(post, node)
    if (node.type === 'webhook') {
      const extra = Object.keys(node.config).filter((k) => !RELAY_POST_KEYS.has(k))
      if (extra.length > 0) reasons.push(`${post}: carries ${extra.join(', ')}, which the port does not know how to carry over`)
      if (recordIdTemplateFor(node.config.body) === null) {
        reasons.push(`${post}: its body is neither a reference to a code node's body nor JSON text with a "submissionId" template, so there is no record id to take`)
      }
    } else if (!isPortedPost(node)) {
      reasons.push(`${post}: is a ${node.type} node that is neither the relay post nor its native port`)
    }
    if (!followsAnswer(node.id)) {
      reasons.push(`${post}: is not reached through a single line of steps from a response node, so it may run before the answer`)
    }
  }

  // Every relay post still in place must post to the one Update Submission relay.
  const relayPosts = [...posts.entries()].filter(([, n]) => n.type === 'webhook')
  const urlCounts = new Map<string, number>()
  for (const [, n] of relayPosts) urlCounts.set(String(n.config.url), (urlCounts.get(String(n.config.url)) ?? 0) + 1)
  const submissionRelay = [...urlCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  for (const [post, n] of relayPosts) {
    if (!isPipedreamRelay(n.config.url)) reasons.push(`${post}: posts to ${hostOf(n.config.url) ?? 'an unreadable URL'}, not the Pipedream Update Submission relay`)
    else if (n.config.url !== submissionRelay) reasons.push(`${post}: posts to a different Pipedream URL from the other outcome posts`)
  }

  // ── The inquiry relay and parallel_1 ──
  const inquiryNode = (byNamespace.get(INQUIRY_RELAY_POST) ?? [])[0] ?? null
  const inquiryRelay = inquiryNode?.config.url ?? null
  const parallel = one(PARALLEL)
  const inquiryAlreadyMoved = inquiryNode === null
  if (inquiryNode) {
    if ((byNamespace.get(INQUIRY_RELAY_POST) ?? []).length > 1) reasons.push(`${INQUIRY_RELAY_POST}: more than one node shares this namespace`)
    if (inquiryNode.type !== 'webhook' || !isPipedreamRelay(inquiryNode.config.url)) reasons.push(`${INQUIRY_RELAY_POST}: is no longer a post to the Pipedream Inquiries relay`)
    const extra = Object.keys(inquiryNode.config).filter((k) => !RELAY_POST_KEYS.has(k))
    if (extra.length > 0) reasons.push(`${INQUIRY_RELAY_POST}: carries ${extra.join(', ')}, which the port does not know about`)
    if (!sameJson(inquiryNode.config.body, INQUIRY_RELAY_BODY)) reasons.push(`${INQUIRY_RELAY_POST}: its body changed from the one the port replaces`)
    if (parallel) {
      if (parallel.type !== 'parallel' || !sameJson(parallel.config.children, PARALLEL_CHILDREN_BEFORE)) {
        reasons.push(`${PARALLEL}: its children are no longer the trades chain and ${INQUIRY_RELAY_POST}`)
      }
      const slot = outOf(parallel.id).filter((e) => e.target === inquiryNode.id)
      if (slot.length !== 1 || slot[0].source_handle !== 'child-1') reasons.push(`${PARALLEL}: ${INQUIRY_RELAY_POST} is not its child-1 slot`)
      if (outOf(parallel.id).length !== 3) reasons.push(`${PARALLEL}: has ${outOf(parallel.id).length} edges out, not its output and two child slots`)
      const after = outOf(inquiryNode.id)
      if (after.length !== 1 || byId.get(after[0].target)?.namespace !== PARALLEL_END) reasons.push(`${INQUIRY_RELAY_POST}: does not lead straight to ${PARALLEL_END}`)
      if (into(inquiryNode.id).length !== 1) reasons.push(`${INQUIRY_RELAY_POST}: is reached from somewhere other than ${PARALLEL}`)
    }
  } else if (parallel && !sameJson(parallel.config.children, PARALLEL_CHILDREN_AFTER)) {
    reasons.push(`${PARALLEL}: ${INQUIRY_RELAY_POST} is gone but the children are not the trades chain alone`)
  }

  // A tenth post to either relay is one the port would leave behind, still writing.
  for (const n of def.nodes) {
    if ((OUTCOME_POSTS as readonly string[]).includes(n.namespace) || n.namespace === INQUIRY_RELAY_POST) continue
    const url = n.config?.url
    if (url !== undefined && (url === submissionRelay || url === inquiryRelay)) reasons.push(`${n.namespace}: an unknown post to a Pipedream relay the port replaces`)
  }

  // ── What the transform will do ──
  const toPort = [...posts.entries()].filter(([post, n]) => selected.has(post) && n.type === 'webhook')
  const portedAfter = new Set<OutcomePost>([...posts.entries()].filter(([post, n]) => n.type !== 'webhook' || selected.has(post)).map(([p]) => p))
  const moveNow = options.moveInquiry && !inquiryAlreadyMoved

  if (options.moveInquiry) {
    const stillRelay = OUTCOME_POSTS.filter((p) => !portedAfter.has(p))
    if (stillRelay.length > 0) {
      reasons.push(`the inquiry cannot move while ${stillRelay.join(', ')} still go to the relay: PDFlow_4__c and the Apex call ride on the native outcome writes`)
    }
    const branch = byNamespace.get(TRADES_BRANCH)?.[0]
    const labels = Array.isArray(branch?.config.branches) ? (branch.config.branches as Array<{ label?: unknown }>).map((b) => b?.label) : []
    if (!branch || branch.type !== 'branch' || !labels.includes(TRADES_ROUTE)) {
      reasons.push(`${TRADES_BRANCH}: no ${TRADES_ROUTE} route, which the inquiry body reads to know the lead posted inquiries before`)
    }
  }

  if (options.collections && !options.moveInquiry) {
    reasons.push('the collections post rides in the inquiry\'s block after each outcome write, so it cannot be added without moving the inquiry')
  }

  // Nothing else may read what a replaced node answered: a native step answers in another shape.
  const replaced = [...toPort.map(([p]) => p as string), ...(moveNow ? [INQUIRY_RELAY_POST, PARALLEL] : [])]
  for (const n of def.nodes) {
    for (const ns of replaced) {
      if (n.namespace === ns) continue
      if (readsStep(n.config, ns) || readsStep(n.variables, ns)) reasons.push(`${n.namespace}: reads steps.${ns}, which the port replaces`)
    }
  }

  const added: OutcomePost[] = []
  /** Posts whose block is there already, read and checked. */
  const blocks = new Map<OutcomePost, CreditPostsBlock>()
  const freeNamespaces = (post: OutcomePost, kinds: readonly CreditPost[]) => {
    const names = kinds.flatMap((c) => [c.bodyNamespace(post), c.apexNamespace(post)])
    for (const ns of names) if (byNamespace.has(ns)) reasons.push(`${ns}: the namespace the port adds is already taken`)
  }
  if (moveNow) {
    for (const post of OUTCOME_POSTS) {
      const node = posts.get(post)
      if (!node) continue
      freeNamespaces(post, options.collections ? CREDIT_POSTS : [INQUIRY_POST])
      for (const ns of [creditPostsNamespace(post), creditPostsEndNamespace(post)]) {
        if (byNamespace.has(ns)) reasons.push(`${ns}: the namespace the port adds is already taken`)
      }
      if (outOf(node.id).length !== 1) reasons.push(`${post}: has ${outOf(node.id).length} steps after it, not one, so the credit posts have no single place to go`)
      added.push(post)
    }
  } else if (inquiryAlreadyMoved) {
    for (const post of OUTCOME_POSTS) {
      const node = posts.get(post)
      if (!node) continue
      const read = readCreditPostsBlock(def, post, node)
      if (Array.isArray(read)) {
        reasons.push(...read)
        continue
      }
      blocks.set(post, read)
      if (options.collections && !read.held.includes(COLLECTIONS_POST)) freeNamespaces(post, [COLLECTIONS_POST])
    }
  } else {
    for (const [post, node] of toPort) {
      if (outOf(node.id).length !== 1) reasons.push(`${post}: has ${outOf(node.id).length} steps after it, not one`)
    }
  }

  if (reasons.length > 0) throw new MainFlowPortRefusal(reasons)

  // ── Rewrite ──
  for (const [, node] of toPort) {
    const recordId = recordIdTemplateFor(node.config.body) as string
    node.type = 'salesforce'
    node.config = portedPostConfig(node.config.body, recordId)
  }

  const ids = new Set([...def.nodes.map((n) => n.id), ...def.edges.map((e) => e.id)])
  const fresh = (seed: string) => {
    const id = stableId(`${MAIN_FLOW_WORKFLOW_ID}:${seed}`)
    if (ids.has(id)) throw new MainFlowPortRefusal([`the id the port derives for ${seed} is already in the definition`])
    ids.add(id)
    return id
  }

  /** Adds one credit post as its slot of a block: its body, its Apex call, and the edges in and out. */
  const addCreditPost = (c: CreditPost, post: OutcomePost, write: DefNode, found: CreditPostsBlock) => {
    const at = write.position ?? { x: 0, y: 0 }
    const bodyNs = c.bodyNamespace(post)
    const apexNs = c.apexNamespace(post)
    const body: DefNode = {
      id: fresh(bodyNs),
      namespace: bodyNs,
      label: `${c.bodyLabel} ${write.label ?? post}`,
      type: 'code',
      position: { x: at.x + c.column, y: at.y + 120 },
      config: { script: c.script, retries: 0, timeout_ms: c.bodyTimeoutMs },
      variables: {},
    }
    const apex: DefNode = {
      id: fresh(apexNs),
      namespace: apexNs,
      label: `${c.apexLabel} ${write.label ?? post}`,
      type: 'salesforce',
      position: { x: at.x + c.column, y: at.y + 180 },
      config: creditApexConfig(c, post),
      variables: {},
    }
    def.nodes.push(body, apex)
    def.edges.push(
      { id: fresh(`${found.block.namespace}:${c.slot}->${bodyNs}`), source: found.block.id, target: body.id, source_handle: c.slot },
      { id: fresh(`${bodyNs}->${apexNs}`), source: body.id, target: apex.id, source_handle: 'output' },
      { id: fresh(`${apexNs}->${found.end.namespace}`), source: apex.id, target: found.end.id, source_handle: 'output' },
    )
    found.held = CREDIT_POSTS.filter((k) => k === c || found.held.includes(k))
    found.block.config = creditPostsConfig(found.held)
  }

  if (moveNow && inquiryNode && parallel) {
    def.nodes = def.nodes.filter((n) => n.id !== inquiryNode.id)
    def.edges = def.edges.filter((e) => e.source !== inquiryNode.id && e.target !== inquiryNode.id)
    parallel.config = { ...parallel.config, children: structuredClone(PARALLEL_CHILDREN_AFTER) }
    for (const post of added) {
      const write = posts.get(post) as DefNode
      const next = outOf(write.id)[0]
      const at = write.position ?? { x: 0, y: 0 }
      const block: DefNode = {
        id: fresh(creditPostsNamespace(post)),
        namespace: creditPostsNamespace(post),
        label: `Credit Posts after ${write.label ?? post}`,
        type: 'parallel',
        position: { x: at.x + 152, y: at.y + 60 },
        config: creditPostsConfig([]),
        variables: {},
      }
      const end: DefNode = {
        id: fresh(creditPostsEndNamespace(post)),
        namespace: creditPostsEndNamespace(post),
        label: `Credit Posts done after ${write.label ?? post}`,
        type: 'parallel_end',
        position: { x: at.x + 152, y: at.y + 240 },
        config: {},
        variables: {},
      }
      def.nodes.push(block, end)
      const originalTarget = next.target
      next.target = block.id
      def.edges.push(
        { id: fresh(`${block.namespace}->${end.namespace}`), source: block.id, target: end.id, source_handle: 'output' },
        { id: fresh(`${end.namespace}->next`), source: end.id, target: originalTarget, source_handle: next.source_handle ?? 'output' },
      )
      const found: CreditPostsBlock = { block, end, held: [] }
      addCreditPost(INQUIRY_POST, post, write, found)
      blocks.set(post, found)
    }
  }

  // The collections post, as a pass of its own after the inquiry's, so porting
  // at once and porting stage by stage build the same definition, in the same order.
  if (options.collections) {
    for (const post of OUTCOME_POSTS) {
      const found = blocks.get(post)
      if (found && !found.held.includes(COLLECTIONS_POST)) addCreditPost(COLLECTIONS_POST, post, posts.get(post) as DefNode, found)
    }
  }

  return def
}
