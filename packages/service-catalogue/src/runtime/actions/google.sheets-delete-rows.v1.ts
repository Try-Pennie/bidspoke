import { googleJson, googleTargetOf, invalid, wholeNumber } from '../google/call'
import { batchUpdateUrl, spreadsheetOf, worksheetOf } from '../google/sheets'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * google.sheets-delete-rows, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * At parity with Pipedream's Delete Rows (PipedreamHQ/pipedream
 * components/google_sheets/actions/delete-rows/delete-rows.mjs, at commit
 * b7d67916): one batchUpdate with a deleteDimension of rows on the worksheet,
 * from `start_row` (inclusive) to `end_row` (exclusive, as Pipedream's prop
 * said and its code did), or the start row alone; the answer returned as it
 * came. An end row not after the start row is refused rather than sent.
 */
export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  googleTargetOf(ctx.target)
  const spreadsheet = spreadsheetOf(args)
  const worksheet = worksheetOf(args)
  const start = wholeNumber(args, 'start_row', 1, true) as number
  const end = wholeNumber(args, 'end_row', 1, false)
  if (end !== null && end <= start) throw invalid('end_row must be after start_row: it is the first row kept')
  return googleJson(ctx, {
    method: 'POST',
    url: batchUpdateUrl(spreadsheet),
    body: { requests: [{ deleteDimension: { range: { sheetId: worksheet, dimension: 'ROWS', startIndex: start - 1, endIndex: end === null ? start : end - 1 } } }] },
    what: 'POST batchUpdate deleteDimension',
    effect: 'write',
  })
}
