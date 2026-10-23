import { googleJson, googleTargetOf, SHEETS_API } from '../google/call'
import { spreadsheetOf } from '../google/sheets'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * google.sheets-get-spreadsheet, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * At parity with Pipedream's Get Spreadsheet by ID (PipedreamHQ/pipedream
 * components/google_sheets/actions/get-spreadsheet-by-id/get-spreadsheet-by-id.mjs,
 * at commit b7d67916): spreadsheets.get, the spreadsheet as Sheets returns it.
 */
export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  googleTargetOf(ctx.target)
  const spreadsheet = spreadsheetOf(args)
  return googleJson(ctx, { method: 'GET', url: `${SHEETS_API}/${spreadsheet}`, what: 'GET spreadsheet', effect: 'read' })
}
