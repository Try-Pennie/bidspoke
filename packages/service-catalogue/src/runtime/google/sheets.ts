import { ActionFailure } from '../failure'
import type { ActionArgs, ActionContext, JsonValue } from '../types'
import { googleJson, invalid, isObject, SHEETS_API, wholeNumber } from './call'

/**
 * What the Sheets actions share (#2337), as Pipedream's Google Sheets app and
 * its worksheet common did (components/google_sheets/google_sheets.app.mjs and
 * actions/common/worksheet.mjs, at commit b7d67916): a step names a spreadsheet
 * and a worksheet by its numeric id, the worksheet's title is read from the
 * spreadsheet, and every range is that title, quoted, then A1 notation. The
 * title is quoted with its own quotes doubled (Pipedream left it bare), so a
 * worksheet named with a space or a quote reads the right cells.
 */

const SPREADSHEET_ID = /^[A-Za-z0-9_-]{10,200}$/
const CELL = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/
const COLUMN = /^[A-Z]{1,3}$/
const RANGE_END = /^(?:[A-Z]{1,3}[1-9][0-9]{0,6}|[A-Z]{1,3}|[1-9][0-9]{0,6})$/

export function spreadsheetOf(args: ActionArgs): string {
  const value = args.spreadsheet_id
  if (typeof value !== 'string' || !SPREADSHEET_ID.test(value.trim())) throw invalid('spreadsheet_id must be a spreadsheet\'s id, the part of its address after /d/')
  return value.trim()
}

export function worksheetOf(args: ActionArgs): number {
  return wholeNumber(args, 'worksheet_id', 0, true) as number
}

export function cellOf(args: ActionArgs, key = 'cell'): string {
  const raw = args[key]
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
  if (!CELL.test(value)) throw invalid(`${key} must be one cell in A1 notation, such as B2`)
  return value
}

export function columnOf(args: ActionArgs): string {
  const value = typeof args.column === 'string' ? args.column.trim().toUpperCase() : ''
  if (!COLUMN.test(value)) throw invalid('column must be a column\'s letters, such as C')
  return value
}

/** A1 notation without a title: one end, or two joined by a colon. */
export function rangeOf(args: ActionArgs): string | null {
  const raw = args.range
  if (raw === undefined || raw === null || raw === '') return null
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
  const ends = value.split(':')
  if (ends.length > 2 || !ends.every((e) => RANGE_END.test(e))) throw invalid('range must be in A1 notation, such as A1:C10, A:C or 2:5')
  return value
}

/** A row's cells: text, numbers and booleans as they are, null as an empty cell; anything else is refused. */
export function cellsOf(row: JsonValue, what: string): Array<string | number | boolean> {
  if (!Array.isArray(row)) throw invalid(`${what} must be a list of cell values`)
  return (row as readonly JsonValue[]).map((v, i) => {
    if (v === null) return ''
    if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v
    throw invalid(`${what}, cell ${i + 1}, is not text, a number, a boolean or null`)
  })
}

/** The worksheet's title, read from the spreadsheet, or a refusal by name before anything is written. */
export async function worksheetTitle(ctx: ActionContext, spreadsheet: string, worksheet: number): Promise<string> {
  const url = `${SHEETS_API}/${spreadsheet}?fields=${encodeURIComponent('sheets.properties(sheetId,title)')}`
  const request = { method: 'GET' as const, url, what: 'GET spreadsheet worksheets', effect: 'read' as const }
  const answer = await googleJson(ctx, request)
  const sheets = Array.isArray(answer.sheets) ? answer.sheets : []
  for (const sheet of sheets) {
    const p = isObject(sheet) && isObject(sheet.properties) ? sheet.properties : null
    if (p !== null && p.sheetId === worksheet && typeof p.title === 'string') return p.title
  }
  throw new ActionFailure('google_sheets_worksheet_not_found', `the spreadsheet holds no worksheet with id ${worksheet}`, 'not_applied')
}

const quoted = (title: string) => `'${title.replace(/'/g, '\'\'')}'`

/** `'<title>'!<a1>`, encoded as one path segment. */
export function a1(title: string, notation: string): string {
  return encodeURIComponent(`${quoted(title)}!${notation}`)
}

/** The whole worksheet, `'<title>'`, encoded as one path segment. */
export function wholeSheet(title: string): string {
  return encodeURIComponent(quoted(title))
}

export const valuesUrl = (spreadsheet: string, range: string): string => `${SHEETS_API}/${spreadsheet}/values/${range}`
export const batchUpdateUrl = (spreadsheet: string): string => `${SHEETS_API}/${spreadsheet}:batchUpdate`
