import { ActionFailure } from '../failure'
import type { ActionArgs, ActionContext, JsonValue } from '../types'
import { googleJson, isObject, unreadable, type GoogleRequest } from './call'
import { SHEETS_APPEND_MAX_BYTES, SHEETS_APPEND_MAX_ROWS } from './limits'
import { a1, spreadsheetOf, valuesUrl, worksheetOf, worksheetTitle } from './sheets'

/**
 * Rows appended to a worksheet (#2337), as Pipedream's `addRowsToSheet` sent
 * them (components/google_sheets/google_sheets.app.mjs, at commit b7d67916):
 * one values.append to the worksheet's column A with valueInputOption
 * USER_ENTERED and insertDataOption INSERT_ROWS, which the plan keeps, every
 * row in the one request, so the rows land whole or not at all. Past
 * SHEETS_APPEND_MAX_ROWS rows or SHEETS_APPEND_MAX_BYTES it is refused by name,
 * never split. Answers Sheets' `updates`, as Pipedream returned them. An append
 * Sheets reports as fewer rows than were sent (each row with a cell in it) fails
 * `google_sheets_partial_append`, applied.
 */
export async function appendRows(ctx: ActionContext, args: ActionArgs, rows: Array<Array<string | number | boolean>>): Promise<JsonValue> {
  const spreadsheet = spreadsheetOf(args)
  const worksheet = worksheetOf(args)
  if (rows.length > SHEETS_APPEND_MAX_ROWS) {
    throw new ActionFailure('google_sheets_too_many_rows', `a step appends at most ${SHEETS_APPEND_MAX_ROWS} rows in one request; it was given ${rows.length}`, 'not_applied')
  }
  const body = { values: rows }
  const bytes = new TextEncoder().encode(JSON.stringify(body)).length
  if (bytes > SHEETS_APPEND_MAX_BYTES) {
    throw new ActionFailure('google_sheets_request_too_large', `the rows are ${bytes} bytes, over the ${SHEETS_APPEND_MAX_BYTES} one append sends`, 'not_applied')
  }
  const title = await worksheetTitle(ctx, spreadsheet, worksheet)
  const request: GoogleRequest = {
    method: 'POST',
    url: `${valuesUrl(spreadsheet, a1(title, 'A:A'))}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    body,
    what: 'POST values append',
    effect: 'write',
  }
  const answer = await googleJson(ctx, request)
  const updates = answer.updates
  if (!isObject(updates)) throw unreadable(request, 'held no updates')
  const written = rows.filter((r) => r.some((c) => c !== '')).length
  if (typeof updates.updatedRows === 'number' && updates.updatedRows !== written) {
    throw new ActionFailure('google_sheets_partial_append', `Sheets wrote ${updates.updatedRows} of the ${written} rows sent`, 'applied')
  }
  return updates
}
