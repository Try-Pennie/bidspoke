import { googleTargetOf, optionalBoolean, text } from '../google/call'
import { a1, columnOf, spreadsheetOf, wholeSheet, worksheetOf, worksheetTitle } from '../google/sheets'
import { readValues } from '../google/values'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * google.sheets-find-row, version 1 (#2337). Released: never edit it; a change
 * is version 2 (the fingerprint check refuses an edit).
 *
 * At parity with Pipedream's Find Row (PipedreamHQ/pipedream
 * components/google_sheets/actions/find-row/find-row.mjs, at commit b7d67916):
 * reads one column and answers each row whose cell there equals the value, as
 * `{ value, index, googleSheetsRowNumber }` (`value` the row as the column read
 * gave it, a one cell list); with `export_row`, reads the worksheet again and
 * answers `{ row, index, googleSheetsRowNumber }` with each whole row. The
 * comparison is of the cell's text, as Pipedream's loose equality compared it.
 */
/** A cell's text: Sheets answers a cell as text unless asked otherwise, and a number or boolean is compared as its text. */
const cellText = (cell: JsonValue): string | null => (typeof cell === 'string' ? cell : typeof cell === 'number' || typeof cell === 'boolean' ? String(cell) : null)

export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  googleTargetOf(ctx.target)
  const spreadsheet = spreadsheetOf(args)
  const worksheet = worksheetOf(args)
  const column = columnOf(args)
  const wanted = text(args, 'value')
  const exportRow = optionalBoolean(args, 'export_row')
  const title = await worksheetTitle(ctx, spreadsheet, worksheet)
  const cells = await readValues(ctx, spreadsheet, a1(title, `${column}:${column}`))
  const matches = cells.flatMap((row, index) => (row.length > 0 && cellText(row[0]) === wanted ? [{ value: row, index, googleSheetsRowNumber: index + 1 }] : []))
  if (!exportRow || matches.length === 0) return matches
  const rows = await readValues(ctx, spreadsheet, wholeSheet(title))
  const indexes = new Set(matches.map((m) => m.index))
  return rows.flatMap((row, index) => (indexes.has(index) ? [{ row, index, googleSheetsRowNumber: index + 1 }] : []))
}
