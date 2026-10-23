import { googleJson, googleTargetOf } from '../google/call'
import { a1, cellOf, cellsOf, spreadsheetOf, valuesUrl, worksheetOf, worksheetTitle } from '../google/sheets'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * google.sheets-update-cell, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * At parity with Pipedream's Update Cell (PipedreamHQ/pipedream
 * components/google_sheets/actions/update-cell/update-cell.mjs, at commit
 * b7d67916): one values.update of `<title>!<cell>:<cell>` with
 * valueInputOption USER_ENTERED, Sheets' UpdateValuesResponse returned. The
 * cell must be one cell in A1 notation, and its value text, a number, a boolean
 * or null (an empty cell).
 */
export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  googleTargetOf(ctx.target)
  const spreadsheet = spreadsheetOf(args)
  const worksheet = worksheetOf(args)
  const cell = cellOf(args)
  const [value] = cellsOf([args.value ?? null], 'value')
  const title = await worksheetTitle(ctx, spreadsheet, worksheet)
  return googleJson(ctx, {
    method: 'PUT',
    url: `${valuesUrl(spreadsheet, a1(title, `${cell}:${cell}`))}?valueInputOption=USER_ENTERED`,
    body: { values: [[value]] },
    what: 'PUT values update',
    effect: 'write',
  })
}
