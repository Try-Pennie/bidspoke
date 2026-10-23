/**
 * The CSV a Bulk API 2.0 job takes and gives back (#2337): RFC 4180, comma
 * separated, LF line endings on the way out (the job is opened with
 * lineEnding LF), LF or CRLF read on the way back. A field holding a comma, a
 * quote, a line break, or whitespace at either edge is quoted, its quotes
 * doubled, so Salesforce reads exactly the value given.
 */

export class CsvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CsvError'
  }
}

const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/

function field(value: string): string {
  return NEEDS_QUOTES.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** A header line and one line per row, each line ended by LF. */
export function toCsv(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  return [columns, ...rows].map((r) => `${r.map(field).join(',')}\n`).join('')
}

/** Every line's fields, a quoted field's line breaks kept. Throws CsvError on what RFC 4180 does not allow. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let value = ''
  let quoted = false
  let afterQuote = false
  let started = false
  const endField = () => {
    row.push(value)
    value = ''
    afterQuote = false
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
    started = false
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c !== '"') {
        value += c
      } else if (text[i + 1] === '"') {
        value += '"'
        i++
      } else {
        quoted = false
        afterQuote = true
      }
      continue
    }
    if (c === ',') {
      started = true
      endField()
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      endRow()
    } else if (c === '"') {
      if (value !== '' || afterQuote) throw new CsvError(`a quote inside an unquoted field, on line ${rows.length + 1}`)
      quoted = true
      started = true
    } else {
      if (afterQuote) throw new CsvError(`text after a closing quote, on line ${rows.length + 1}`)
      value += c
      started = true
    }
  }
  if (quoted) throw new CsvError('a quoted field never ends')
  if (started || value !== '' || row.length > 0 || afterQuote) endRow()
  return rows
}
