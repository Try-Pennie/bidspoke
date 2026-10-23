import { googleTargetOf, invalid } from '../google/call'
import { appendRows } from '../google/append'
import { cellsOf } from '../google/sheets'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * google.sheets-add-rows, version 1 (#2337). Released: never edit it; a change
 * is version 2 (the fingerprint check refuses an edit).
 *
 * At parity with Pipedream's Add Multiple Rows (PipedreamHQ/pipedream
 * components/google_sheets/actions/add-multiple-rows/add-multiple-rows.mjs, at
 * commit b7d67916): a list of rows, each a list of cell values, appended in one
 * values.append with USER_ENTERED and INSERT_ROWS (google/append.ts), Sheets'
 * `updates` returned. What differs, on purpose: past SHEETS_APPEND_MAX_ROWS rows
 * it is refused by name; a cell that is not text, a number, a boolean or null is
 * refused; resetting the rows' format is not offered, since no step set it.
 */
export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  googleTargetOf(ctx.target)
  const rows = args.rows
  if (!Array.isArray(rows) || rows.length === 0) throw invalid('rows must be a list of one or more rows, each a list of cell values')
  return appendRows(ctx, args, (rows as readonly JsonValue[]).map((r, i) => cellsOf(r, `row ${i + 1}`)))
}
