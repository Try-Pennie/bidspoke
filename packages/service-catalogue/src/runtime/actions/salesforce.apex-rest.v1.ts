import { salesforceApexPath, salesforceApexUrl } from '@bidspoke/salesforce-api'
import { invalid, isObject, salesforceInstanceOf, salesforceSend, text } from '../salesforce/call'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * salesforce.apex-rest, version 1 (#2337). Released: never edit it; a change is
 * version 2 (the fingerprint check refuses an edit).
 *
 * One call to the org's own Apex REST class (/services/apexrest/<path>), as the
 * engine bidding code steps call custommdt/bid and prospect-trades and the
 * Tripoint submission calls nu_dse/CreateProspect in its own org, on the money
 * path's Apex URL rule (salesforceApexPath, salesforceApexUrl). The path is
 * relative to /services/apexrest, each segment plain (letters, digits, - _ . ~
 * and %), never `.` or `..`, so a value cannot leave the Apex root; parameters
 * go in `params`, encoded. Answers `{ status, body }`, the body as JSON or text.
 * What a class does is its own, so every call may have side effects and is
 * never repeated on an uncertain outcome.
 */

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const
type Method = (typeof METHODS)[number]
const SEGMENT = /^[A-Za-z0-9_\-.~%]+$/

function pathOf(args: ActionArgs): string {
  const segments = text(args, 'path').trim().replace(/^\/+/, '').split('/')
  if (segments.some((s) => !SEGMENT.test(s) || s === '.' || s === '..')) {
    throw invalid('path must be a path under /services/apexrest, plain segments only, with any parameters in params')
  }
  return segments.join('/')
}

function paramsOf(args: ActionArgs): string {
  const value = args.params
  if (value === undefined || value === null) return ''
  if (!isObject(value)) throw invalid('params must be an object of names and text, number or boolean values')
  const params = new URLSearchParams()
  for (const [name, v] of Object.entries(value)) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw invalid(`params.${name} must be text, a number or a boolean`)
    params.append(name, String(v))
  }
  const query = params.toString()
  return query === '' ? '' : `?${query}`
}

export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  const instance = salesforceInstanceOf(ctx.target)
  const method = text(args, 'method').trim().toUpperCase()
  if (!(METHODS as readonly string[]).includes(method)) throw invalid(`method must be one of ${METHODS.join(', ')}`)
  const path = pathOf(args)
  const query = paramsOf(args)
  const body = args.body
  if (method === 'GET' && body !== undefined && body !== null) throw invalid('a GET sends no body')
  const answer = await salesforceSend(ctx, {
    method: method as Method,
    url: `${salesforceApexUrl(instance, salesforceApexPath(`services/apexrest/${path}`))}${query}`,
    body: body === null ? undefined : body,
    // The class's own name only: a later segment can carry a step's value.
    what: `${method} apexrest/${path.split('/')[0]}`,
    effect: 'write',
  })
  return { status: answer.status, body: answer.body as JsonValue }
}
