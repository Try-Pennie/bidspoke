/**
 * One response vocabulary per partner (L89), one implementation of the signal
 * matching (L370). The decline half of a partner's rules is the existing
 * `response_classification.rejection_signals`, which Main Flow's bid group reads
 * through the classifier; the accept half is `accept_signals`. Both are matched
 * here, and the classifier imports this file back.
 */

/**
 * A signal is one field path plus exactly one operator, written as the key the
 * form and the existing config use. `field` may carry `[]` after a segment to
 * map over an array: `details[].message` yields every message.
 */
export interface Signal {
  field: string
  equals?: unknown
  contains?: string
  in?: unknown[]
  not_in?: unknown[]
  present?: boolean
  any_item_contains?: string
  any_item_word_prefix_ci?: string
}

/** Walks a dot path, mapping over arrays at a `[]` segment. Anything unreachable is undefined. */
export function getBodyField(body: unknown, field: string): unknown {
  if (!field) return undefined
  return walk(body, field.split('.').filter(Boolean))
}

function walk(cur: unknown, parts: string[]): unknown {
  if (parts.length === 0) return cur
  if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
  const [head, ...rest] = parts
  if (head.endsWith('[]')) {
    const arr = (cur as Record<string, unknown>)[head.slice(0, -2)]
    if (!Array.isArray(arr)) return undefined
    return arr.map((item) => walk(item, rest))
  }
  return walk((cur as Record<string, unknown>)[head], rest)
}

/**
 * Equality across the partner response value (typed from its JSON) and the
 * configured value (author entered), coerced in both directions: 1001 equals
 * "1001", true equals "true". An empty string is never numeric.
 */
export function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'boolean' && typeof b === 'string') return String(a) === b
  if (typeof b === 'boolean' && typeof a === 'string') return String(b) === a
  if (typeof a === 'number' && typeof b === 'string' && b.trim() !== '') return a === Number(b)
  if (typeof b === 'number' && typeof a === 'string' && a.trim() !== '') return b === Number(a)
  return false
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function matchSignal(sig: Signal, body: unknown): boolean {
  const value = getBodyField(body, sig.field)
  if (sig.present !== undefined) {
    const exists = value !== undefined && value !== null
    return sig.present ? exists : !exists
  }
  if (sig.equals !== undefined) return looseEquals(value, sig.equals)
  if (sig.contains !== undefined) return typeof value === 'string' && value.includes(sig.contains)
  if (Array.isArray(sig.in)) return sig.in.some((m) => looseEquals(value, m))
  if (Array.isArray(sig.not_in)) {
    if (value === undefined) return false // a missing field never matches not_in
    return !sig.not_in.some((m) => looseEquals(value, m))
  }
  if (sig.any_item_contains !== undefined) {
    const needle = sig.any_item_contains
    return Array.isArray(value) && value.some((v) => typeof v === 'string' && v.includes(needle))
  }
  if (sig.any_item_word_prefix_ci !== undefined) {
    const re = new RegExp(`^\\s*${escapeRegExp(sig.any_item_word_prefix_ci)}\\b`, 'i')
    return Array.isArray(value) && value.some((v) => typeof v === 'string' && re.test(v))
  }
  return false
}

export type SaleOutcome = 'accepted' | 'declined_by_buyer' | 'buyer_error' | 'outcome_unknown'

export interface SaleOutcomeResult {
  outcome: SaleOutcome
  /** Indices of accept rules that did not match. Empty when accepted or when no accept rule was checked. */
  acceptFailed: number[]
  /** Indices of decline rules that matched. */
  declineMatched: number[]
}

/**
 * The four outcomes, with a positive accept rule (L181):
 * - accepted only when the status is 2xx and EVERY accept rule matches. An empty
 *   accept list therefore never accepts (L72); validateProfile refuses to enable
 *   a profile whose partner has none.
 * - declined_by_buyer when any decline rule matches, a 5xx included.
 * - buyer_error when the lead was definitely not processed: never sent, an HTML
 *   block page, or a 4xx.
 * - outcome_unknown otherwise: the buyer may have taken the lead.
 */
export function evaluateSaleOutcome(
  acceptRules: readonly Signal[],
  declineRules: readonly Signal[],
  status: number | null,
  body: unknown,
  isHtml: boolean,
  sent: boolean
): SaleOutcomeResult {
  if (!sent || isHtml) return { outcome: 'buyer_error', acceptFailed: [], declineMatched: [] }

  const declineMatched = declineRules.flatMap((sig, i) => (matchSignal(sig, body) ? [i] : []))
  const is2xx = status !== null && status >= 200 && status < 300
  const acceptFailed = is2xx && acceptRules.length > 0
    ? acceptRules.flatMap((sig, i) => (matchSignal(sig, body) ? [] : [i]))
    : []

  if (is2xx && acceptRules.length > 0 && acceptFailed.length === 0) {
    return { outcome: 'accepted', acceptFailed, declineMatched }
  }
  if (declineMatched.length > 0) return { outcome: 'declined_by_buyer', acceptFailed, declineMatched }
  if (status !== null && status >= 400 && status < 500) return { outcome: 'buyer_error', acceptFailed, declineMatched }
  return { outcome: 'outcome_unknown', acceptFailed, declineMatched }
}

/** The class Salesforce records for a sale: the values of the Tripoint_Response__c picklist, now derived per buyer (#1416). */
export const RESPONSE_CLASSES = ['Success', 'Duplicate', 'Fail'] as const
export type ResponseClass = (typeof RESPONSE_CLASSES)[number]

/**
 * The Salesforce class of a sale, from the winner's own rules (#1416): an
 * accepted sale is Success; a decline is Duplicate when any of the buyer's
 * duplicate rules matches the answer and Fail otherwise; a buyer error or an
 * unknown outcome has no class, because the buyer gave no answer to classify.
 * Before this the two Engine scripts each carried Tripoint's result code
 * mapping, so a second buyer would have been classified by Tripoint's codes. A
 * buyer with no duplicate rules reports every decline as Fail, never a guess.
 */
export function responseClassOf(outcome: SaleOutcome, duplicateRules: readonly Signal[], body: unknown): ResponseClass | null {
  switch (outcome) {
    case 'accepted': return 'Success'
    case 'declined_by_buyer': return duplicateRules.some((sig) => matchSignal(sig, body)) ? 'Duplicate' : 'Fail'
    case 'buyer_error':
    case 'outcome_unknown':
      return null
  }
}
