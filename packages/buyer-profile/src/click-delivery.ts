/**
 * A click buyer's delivery (#1639): the URL a click is posted to, chosen by the
 * lead's state, and the reply that counts as sold. It lives on the buyer
 * profile, so an endpoint the buyer moves is a profile edit with version
 * history rather than a script edit and a workflow save.
 *
 * The rules here are the only ones: validateProfile refuses a delivery against
 * them on the form and in the profile API, buyer_click_send picks its route
 * with pickClickRoute and compiles the line with successPatternOf, and the
 * canvas save validation judges the node's own success line with the same
 * successPatternOf. So a delivery the node would refuse on every click cannot
 * be saved first (L370).
 */
import { parseUsState } from './parse'
import type { UsState } from './vocab'

/** One place a click can be posted. An empty states list is the catch-all: every state no other route lists. */
export interface ClickRoute {
  name: string
  url: string
  states: string[]
}

/** The evaluator's shape, as BuyerProfile carries it. */
export interface ClickDelivery {
  routes: ClickRoute[]
  successPattern: string
}

/** The wire shape, as the profile document and buyer_profile_document carry it. */
export interface ClickDeliveryDocument {
  routes: ClickRoute[]
  success_pattern: string
}

export const clickDeliveryFromDocument = (d: ClickDeliveryDocument): ClickDelivery => ({
  routes: d.routes.map((r) => ({ name: r.name, url: r.url, states: [...r.states] })),
  successPattern: d.success_pattern,
})

// ── The success line ─────────────────────────────────────────────────────────

/** A buyer's success line as buyer_click_send runs it: matched against the WHOLE answer. */
export function compileSuccessPattern(successPattern: string): RegExp {
  return new RegExp(`^(?:${successPattern})$`)
}

export type SuccessPatternProblem = 'success_pattern_unset' | 'success_pattern_invalid' | 'success_pattern_no_id_group'
export type SuccessPatternRule = { ok: true; pattern: RegExp } | { ok: false; code: SuccessPatternProblem; reason: string }

/**
 * The one success line rule: set, compiles, and holds a named `id` group for
 * the buyer's lead id. The group is found by matching an alternation that
 * always matches the empty string, whose groups object names every group the
 * pattern declares, so an escaped `\(\?<id>` in the text is not mistaken for one.
 */
export function successPatternOf(value: unknown): SuccessPatternRule {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, code: 'success_pattern_unset', reason: 'it is unset, and there is no default' }
  let pattern: RegExp
  let groups: Record<string, string | undefined> | undefined
  try {
    pattern = compileSuccessPattern(value)
    groups = new RegExp(`(?:${value})|`).exec('')?.groups
  } catch (err) {
    return { ok: false, code: 'success_pattern_invalid', reason: `it is not a valid pattern: ${err instanceof Error ? err.message : 'it does not compile'}` }
  }
  if (!groups || !('id' in groups)) return { ok: false, code: 'success_pattern_no_id_group', reason: 'it has no (?<id>...) group to capture the partner lead id' }
  return { ok: true, pattern }
}

// ── Route choice ─────────────────────────────────────────────────────────────

export interface PickedClickRoute {
  route: ClickRoute
  /** state: a route lists the lead's state. catch_all: the state is in no route. no_state: the lead had no readable state. */
  matched: 'state' | 'catch_all' | 'no_state'
  state: UsState | null
}

/**
 * The route for one click. The state is read the way the profile box reads it
 * (parseUsState), so a full name or lower case matches its code. A state in no
 * route, or none at all, goes to the catch-all. Null when the delivery holds no
 * catch-all, which validateProfile refuses on save, so the node refuses by name
 * rather than guessing a route.
 */
export function pickClickRoute(delivery: ClickDelivery, rawState: unknown): PickedClickRoute | null {
  const catchAll = delivery.routes.find((r) => r.states.length === 0)
  const state = parseUsState(rawState)
  if (state !== null) {
    const listed = delivery.routes.find((r) => r.states.includes(state))
    if (listed) return { route: listed, matched: 'state', state }
  }
  if (!catchAll) return null
  return { route: catchAll, matched: state === null ? 'no_state' : 'catch_all', state }
}

/** True when a URL string is an absolute https URL. */
export function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}
