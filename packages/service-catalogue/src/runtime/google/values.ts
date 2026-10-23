import type { ActionContext, JsonValue } from '../types'
import { googleJson, unreadable, type GoogleRequest } from './call'
import { valuesUrl } from './sheets'

/**
 * One values.get (#2337): the rows of a range, as Pipedream's Sheets actions
 * read them (`values ?? []`: Sheets leaves `values` out of a range with nothing
 * in it, so an empty range is an empty list, never a missing one).
 */
export async function readValues(ctx: ActionContext, spreadsheet: string, range: string): Promise<JsonValue[][]> {
  const request: GoogleRequest = { method: 'GET', url: valuesUrl(spreadsheet, range), what: 'GET values', effect: 'read' }
  const answer = await googleJson(ctx, request)
  if (answer.values === undefined) return []
  if (!Array.isArray(answer.values) || !answer.values.every(Array.isArray)) throw unreadable(request, 'held values that are not rows')
  return answer.values as JsonValue[][]
}
