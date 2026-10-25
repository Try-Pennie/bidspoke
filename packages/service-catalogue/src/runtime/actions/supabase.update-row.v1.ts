import { ActionFailure } from '../failure'
import { asSupabaseJs, blank, filterValueOf, identifierOf, rowOf, supabaseRequest } from '../supabase/call'
import type { ActionRun } from '../types'

/**
 * supabase.update-row, version 1 (#2337). Released: never edit it; a change is
 * version 2 (the fingerprint check refuses an edit).
 *
 * Pipedream's Update Row (PipedreamHQ/pipedream
 * components/supabase/actions/update-row/update-row.mjs, at commit b7d67916):
 * `from(table).update(data).eq(column, value).select()`, one PATCH to
 * /rest/v1/<table>?<column>=eq.<value> with Prefer: return=representation,
 * answered as supabase-js answered it, the updated rows in `data` (an empty
 * list when no row matched). What differs, on purpose: column, value and a
 * non empty data are required before anything is sent, so the action can
 * never send a PATCH with no filter, which would update every row of the table.
 */
export const run: ActionRun = async (ctx, args) => {
  const table = identifierOf(args, 'table', 'supabase_table_missing') as string
  const column = identifierOf(args, 'column', 'supabase_column_missing') as string
  const value = filterValueOf(args, 'value', 'supabase_value_missing') as string
  if (blank(args.data)) throw new ActionFailure('supabase_data_missing', 'the step names no columns to update', 'not_applied')
  const data = rowOf(args.data, 'data')
  const answer = await supabaseRequest(ctx, { method: 'PATCH', table, query: [[column, `eq.${value}`]], body: data, prefer: 'return=representation', writes: true })
  return asSupabaseJs(answer, null)
}
