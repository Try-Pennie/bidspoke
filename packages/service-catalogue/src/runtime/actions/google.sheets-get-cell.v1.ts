import { googleTargetOf } from '../google/call'
import { a1, cellOf, spreadsheetOf, worksheetOf, worksheetTitle } from '../google/sheets'
import { readValues } from '../google/values'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * google.sheets-get-cell, version 1 (#2337). Released: never edit it; a change
 * is version 2 (the fingerprint check refuses an edit).
 *
 * At parity with Pipedream's Get Cell (PipedreamHQ/pipedream
 * components/google_sheets/actions/get-cell/get-cell.mjs, at commit b7d67916):
 * one cell's value, or null when it is empty.
 */
export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  googleTargetOf(ctx.target)
  const spreadsheet = spreadsheetOf(args)
  const worksheet = worksheetOf(args)
  const cell = cellOf(args)
  const title = await worksheetTitle(ctx, spreadsheet, worksheet)
  const rows = await readValues(ctx, spreadsheet, a1(title, `${cell}:${cell}`))
  return rows[0]?.[0] ?? null
}
