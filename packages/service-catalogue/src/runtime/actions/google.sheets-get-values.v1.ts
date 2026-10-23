import { googleTargetOf } from '../google/call'
import { a1, rangeOf, spreadsheetOf, wholeSheet, worksheetOf, worksheetTitle } from '../google/sheets'
import { readValues } from '../google/values'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * google.sheets-get-values, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * At parity with Pipedream's Get Values in Range (PipedreamHQ/pipedream
 * components/google_sheets/actions/get-values-in-range/get-values-in-range.mjs,
 * at commit b7d67916): the worksheet's rows, or a range of them in A1 notation,
 * as a list of rows; an empty range is an empty list.
 */
export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  googleTargetOf(ctx.target)
  const spreadsheet = spreadsheetOf(args)
  const worksheet = worksheetOf(args)
  const range = rangeOf(args)
  const title = await worksheetTitle(ctx, spreadsheet, worksheet)
  return readValues(ctx, spreadsheet, range === null ? wholeSheet(title) : a1(title, range))
}
