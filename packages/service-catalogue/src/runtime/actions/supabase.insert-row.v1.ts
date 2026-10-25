import { ActionFailure } from '../failure'
import { asSupabaseJs, blank, identifierOf, invalid, rowOf, supabaseRequest } from '../supabase/call'
import type { ActionRun, JsonValue } from '../types'

/**
 * supabase.insert-row, version 1 (#2337). Released: never edit it; a change is
 * version 2 (the fingerprint check refuses an edit).
 *
 * Pipedream's Insert Row (PipedreamHQ/pipedream
 * components/supabase/actions/insert-row/insert-row.mjs, at commit b7d67916):
 * `from(table).insert(data).select()`, one POST to /rest/v1/<table> with
 * Prefer: return=representation, answered as supabase-js answered it. `data`
 * is one row as an object, or a list of rows, which PostgREST inserts in one
 * statement, so they land whole or not at all. What differs, on purpose: a
 * blank or empty `data` is refused before sending, where Pipedream inserted an
 * empty row, and a failure throws by name rather than in a JSON dump of the
 * response, which could quote the row.
 */
export const run: ActionRun = async (ctx, args) => {
  const table = identifierOf(args, 'table', 'supabase_table_missing') as string
  const data = args.data
  if (data === undefined || blank(data)) throw new ActionFailure('supabase_data_missing', 'the step names no row to insert', 'not_applied')
  let body: JsonValue
  if (Array.isArray(data)) {
    const list: readonly JsonValue[] = data
    if (list.length === 0) throw invalid('data must hold at least one row')
    body = list.map((row, i) => rowOf(row, `data row ${i + 1}`))
  } else {
    if (typeof data !== 'object' || data === null) throw invalid('data must be a JSON object, or a list of them')
    body = rowOf(data, 'data')
  }
  const answer = await supabaseRequest(ctx, { method: 'POST', table, query: [], body, prefer: 'return=representation', writes: true })
  return asSupabaseJs(answer, null)
}
