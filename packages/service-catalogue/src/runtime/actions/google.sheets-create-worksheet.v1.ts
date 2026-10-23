import { googleJson, googleTargetOf, invalid, text } from '../google/call'
import { batchUpdateUrl, spreadsheetOf } from '../google/sheets'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * google.sheets-create-worksheet, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * At parity with Pipedream's Create Worksheet (PipedreamHQ/pipedream
 * components/google_sheets/actions/create-worksheet/create-worksheet.mjs, at
 * commit b7d67916): one batchUpdate with an addSheet request for the title, its
 * answer returned as it came.
 */
export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  googleTargetOf(ctx.target)
  const spreadsheet = spreadsheetOf(args)
  const title = text(args, 'title').trim()
  if (title.length > 100) throw invalid('title must be at most 100 characters')
  return googleJson(ctx, {
    method: 'POST',
    url: batchUpdateUrl(spreadsheet),
    body: { requests: [{ addSheet: { properties: { title } } }] },
    what: 'POST batchUpdate addSheet',
    effect: 'write',
  })
}
