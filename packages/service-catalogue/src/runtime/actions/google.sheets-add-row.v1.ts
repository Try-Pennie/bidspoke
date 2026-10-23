import { googleTargetOf } from '../google/call'
import { appendRows } from '../google/append'
import { cellsOf } from '../google/sheets'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * google.sheets-add-row, version 1 (#2337). Released: never edit it; a change is
 * version 2 (the fingerprint check refuses an edit).
 *
 * Pipedream's Add Single Row (PipedreamHQ/pipedream
 * components/google_sheets/actions/add-single-row/add-single-row.mjs, at commit
 * b7d67916), appending: one row of cell values appended to the worksheet with
 * USER_ENTERED and INSERT_ROWS (google/append.ts), Sheets' `updates` returned.
 * What differs, on purpose: a cell that is not text, a number, a boolean or
 * null is refused, where Pipedream turned it into JSON text; the step names the
 * row's values in column order (the column by column form of the 2.x versions
 * is the step form's to build, Phase 8); inserting at a row index is not
 * offered, since no step's version had it.
 */
export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  googleTargetOf(ctx.target)
  return appendRows(ctx, args, [cellsOf(args.values ?? null, 'values')])
}
