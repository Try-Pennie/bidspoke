import { googleJson, googleTargetOf, invalid, wholeNumber } from '../google/call'
import { a1, spreadsheetOf, valuesUrl, worksheetOf, worksheetTitle } from '../google/sheets'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * google.sheets-clear-rows, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * At parity with Pipedream's Clear Rows (PipedreamHQ/pipedream
 * components/google_sheets/actions/clear-rows/clear-rows.mjs, at commit
 * b7d67916): one values.clear of `<title>!<start>:<end>`, the rows' contents
 * emptied and the rows kept. Pipedream's prop called the end row exclusive but
 * its range made it inclusive, so a ported step clears what it cleared: the end
 * row too. The answer is returned as it came.
 */
export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  googleTargetOf(ctx.target)
  const spreadsheet = spreadsheetOf(args)
  const worksheet = worksheetOf(args)
  const start = wholeNumber(args, 'start_row', 1, true) as number
  const end = wholeNumber(args, 'end_row', 1, false) ?? start
  if (end < start) throw invalid('end_row must not be before start_row')
  const title = await worksheetTitle(ctx, spreadsheet, worksheet)
  return googleJson(ctx, { method: 'POST', url: `${valuesUrl(spreadsheet, a1(title, `${start}:${end}`))}:clear`, body: {}, what: 'POST values clear', effect: 'write' })
}
