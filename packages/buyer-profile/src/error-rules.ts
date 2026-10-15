/**
 * The default error rules (#2143, PM-11): how the engine classifies a failed
 * call when nothing the person set says otherwise, written once as data.
 *
 * The engine's classifier (apps/worker/src/engine/error-classifier.ts:
 * classifyHttpError, classifyHttpErrorWithBody, classifyTransportError,
 * isSaturationError, isDeterministicCodeError) reads every decision, status,
 * marker and name from DEFAULT_ERROR_RULES, and the partners page shows the
 * same rows under the person's own rules as fixed rows marked Default, so the
 * page cannot describe a default the engine does not apply (L41, L107). It
 * lives in this package because the web app cannot import the Worker.
 *
 * A partner's own response_classification rules are checked before any of
 * these (evaluateResponseClassification), so a default is what happens when
 * none of them matched.
 */

export type ErrorDecision = 'transient' | 'permanent'

/**
 * Where a default applies. partner_call: a partner_bid call to a buyer partner's
 * bid API. service_call: the Integration and Salesforce nodes. code_node: a
 * Code node's script or the error response it returns. buyer_call: a
 * buyer_select or buyer_click_send call to a buyer, which no default here
 * classifies: those answers are judged by the sale outcome rules (outcome.ts,
 * click-send.ts), whose unknown answer holds the sale rather than retrying it.
 */
export const ERROR_RULE_SCOPES = ['partner_call', 'buyer_call', 'service_call', 'code_node'] as const
export type ErrorRuleScope = (typeof ERROR_RULE_SCOPES)[number]

export type ErrorRuleMatch =
  /** The answer's HTTP status is one of these. */
  | { kind: 'status'; statuses: readonly number[] }
  /** Any other status at or above `from`. */
  | { kind: 'status_from'; from: number }
  /** Any other status below `below`: a non success answer that is not an error status. */
  | { kind: 'status_below'; below: number }
  /** The answer's body is an HTML document, at any status: it died at an edge or proxy. */
  | { kind: 'html_error_page' }
  /** The thrower marked the error permanent itself (a Salesforce 4xx, a Branch node's else that errors). */
  | { kind: 'marked_permanent' }
  /**
   * A Code node script threw one of these. fetch() network failures in Workers
   * also reject with a TypeError, so an error named `networkFailureName` whose
   * message carries one of `unlessMessageContains` is a network blip instead.
   */
  | { kind: 'code_error'; names: readonly string[]; networkFailureName: string; unlessMessageContains: readonly string[] }
  /** The error says the upstream has no capacity right now. */
  | { kind: 'saturated'; markers: readonly string[] }
  /** No answer at all: a network failure or a timeout. */
  | { kind: 'no_response' }

export interface DefaultErrorRule {
  id: string
  match: ErrorRuleMatch
  decision: ErrorDecision
  /** False when the error stays transient for alerts and circuit breakers but is not retried within the run. */
  retriedInRun: boolean
  appliesTo: readonly ErrorRuleScope[]
  /** The condition, in the words the page shows it by. */
  label: string
  /**
   * Null when the default can be shown as a fixed row beside the person's own
   * rules; otherwise why it cannot, which the page names instead (PM-11).
   */
  notShownBecause: string | null
}

/**
 * Every default, in the order the classifier applies them: the HTML page rule
 * before any status, the listed statuses before the ranges, and for an error
 * with no answer the thrower's own mark, then a script's programming error,
 * then the network default.
 */
export const DEFAULT_ERROR_RULES = [
  {
    id: 'html_error_page',
    match: { kind: 'html_error_page' },
    decision: 'transient',
    retriedInRun: true,
    appliesTo: ['partner_call', 'service_call'],
    label: 'An HTML error page instead of data, at any status',
    notShownBecause: null,
  },
  {
    id: 'rate_limited',
    match: { kind: 'status', statuses: [429] },
    decision: 'transient',
    retriedInRun: true,
    appliesTo: ['partner_call', 'service_call', 'code_node'],
    label: 'HTTP 429',
    notShownBecause: null,
  },
  {
    id: 'gateway_unavailable',
    match: { kind: 'status', statuses: [502, 503, 504] },
    decision: 'transient',
    retriedInRun: true,
    appliesTo: ['partner_call', 'service_call', 'code_node'],
    label: 'HTTP 502, 503 or 504',
    notShownBecause: null,
  },
  {
    id: 'error_status',
    match: { kind: 'status_from', from: 400 },
    decision: 'permanent',
    retriedInRun: true,
    appliesTo: ['partner_call', 'service_call', 'code_node'],
    label: 'Any other status from 400 up',
    notShownBecause: null,
  },
  {
    id: 'unrecognized_status',
    match: { kind: 'status_below', below: 400 },
    decision: 'permanent',
    retriedInRun: true,
    appliesTo: ['partner_call', 'service_call', 'code_node'],
    label: 'Any other unsuccessful status below 400',
    notShownBecause: null,
  },
  {
    id: 'marked_permanent',
    match: { kind: 'marked_permanent' },
    decision: 'permanent',
    retriedInRun: true,
    appliesTo: ['service_call', 'code_node'],
    label: 'An error the node marked permanent itself',
    notShownBecause: 'It is decided inside the node, before any answer reaches the rules.',
  },
  {
    id: 'code_programming_error',
    match: {
      kind: 'code_error',
      names: ['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'],
      networkFailureName: 'TypeError',
      unlessMessageContains: ['fetch failed', 'failed to fetch', 'network connection lost', 'the network connection was lost', 'connection was closed', 'connection lost'],
    },
    decision: 'permanent',
    retriedInRun: true,
    appliesTo: ['code_node'],
    label: 'A programming error in a Code node script',
    notShownBecause: 'It applies only to Code node scripts.',
  },
  {
    id: 'saturated',
    match: { kind: 'saturated', markers: ['REQUEST_LIMIT_EXCEEDED'] },
    decision: 'transient',
    retriedInRun: false,
    appliesTo: ['partner_call', 'service_call', 'code_node'],
    label: 'The upstream says it has no capacity (REQUEST_LIMIT_EXCEEDED)',
    notShownBecause: 'It counts as temporary but is not retried within the run, which a rule row cannot say.',
  },
  {
    id: 'no_response',
    match: { kind: 'no_response' },
    decision: 'transient',
    retriedInRun: true,
    appliesTo: ['partner_call', 'service_call', 'code_node'],
    label: 'No answer: a network failure or a timeout',
    notShownBecause: null,
  },
] as const satisfies readonly DefaultErrorRule[]

export type DefaultErrorRuleId = (typeof DEFAULT_ERROR_RULES)[number]['id']

/** One rule by its id; throws on an id that names none, so a renamed rule fails where it is read. */
export function defaultErrorRule<K extends ErrorRuleMatch['kind']>(id: DefaultErrorRuleId, kind: K): DefaultErrorRule & { match: Extract<ErrorRuleMatch, { kind: K }> } {
  const rule = (DEFAULT_ERROR_RULES as readonly DefaultErrorRule[]).find((r) => r.id === id)
  if (!rule || rule.match.kind !== kind) throw new Error(`no default error rule ${id} of kind ${kind}`)
  return rule as DefaultErrorRule & { match: Extract<ErrorRuleMatch, { kind: K }> }
}

/** The status rules in the order the classifier reads them: listed statuses, then the ranges. */
export function statusDecision(status: number): ErrorDecision {
  for (const rule of DEFAULT_ERROR_RULES as readonly DefaultErrorRule[]) {
    const m = rule.match
    if (m.kind === 'status' && m.statuses.includes(status)) return rule.decision
  }
  for (const rule of DEFAULT_ERROR_RULES as readonly DefaultErrorRule[]) {
    const m = rule.match
    if (m.kind === 'status_from' && status >= m.from) return rule.decision
    if (m.kind === 'status_below' && status < m.below) return rule.decision
  }
  throw new Error(`no default error rule covers status ${status}`)
}

export interface DefaultErrorRows {
  /** Shown as fixed rows marked Default, in classifier order. */
  shown: DefaultErrorRule[]
  /** Apply to these calls but cannot be a row: the page names each as not shown. */
  notShown: DefaultErrorRule[]
}

/**
 * The defaults the partners page lists for a partner's calls (PM-11): every
 * rule that applies to at least one of `scopes`, never one that applies only
 * to Code nodes, split into rows and the ones named as not shown.
 */
export function defaultErrorRowsFor(scopes: readonly ErrorRuleScope[]): DefaultErrorRows {
  const out: DefaultErrorRows = { shown: [], notShown: [] }
  for (const rule of DEFAULT_ERROR_RULES as readonly DefaultErrorRule[]) {
    if (!rule.appliesTo.some((s) => s !== 'code_node' && scopes.includes(s))) continue
    if (rule.notShownBecause === null) out.shown.push(rule)
    else out.notShown.push(rule)
  }
  return out
}

/** The calls the partners page makes for a partner: its bid API and, for a buyer, buyer selection and click sends. */
export const PARTNER_PAGE_ERROR_SCOPES: readonly ErrorRuleScope[] = ['partner_call', 'buyer_call']
