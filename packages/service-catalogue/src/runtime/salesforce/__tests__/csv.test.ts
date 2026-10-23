import { describe, expect, it } from 'vitest'
import { CsvError, parseCsv, toCsv } from '../csv'

/**
 * The CSV a Bulk API 2.0 job takes and gives back (#2337): RFC 4180, comma
 * separated, LF line endings, every field that holds a comma, a quote, a line
 * break or edge whitespace quoted with its quotes doubled. Salesforce's own
 * results come back the same way, a field's line breaks included.
 */
describe('toCsv', () => {
  it('writes a header and one line per row, quoting only what needs it', () => {
    expect(toCsv(['Id', 'Name', 'Note__c'], [['00Q1', 'Smith, Jo', 'said "hi"'], ['00Q2', 'Lee', 'line\nbreak'], ['00Q3', ' padded ', '']]))
      .toBe('Id,Name,Note__c\n00Q1,"Smith, Jo","said ""hi"""\n00Q2,Lee,"line\nbreak"\n00Q3," padded ",\n')
  })
})

describe('parseCsv', () => {
  it('reads what toCsv writes back to the same cells', () => {
    const rows = [['Id', 'Name'], ['00Q1', 'Smith, Jo'], ['00Q2', 'a "b"\r\nc'], ['00Q3', '']]
    expect(parseCsv(toCsv(rows[0], rows.slice(1)))).toEqual(rows)
  })

  it('reads CRLF line endings and a last line with no break', () => {
    expect(parseCsv('"sf__Id","sf__Error",Email\r\n00Q1,"INVALID_EMAIL_ADDRESS:Email: invalid",x\r\n00Q2,,y')).toEqual([
      ['sf__Id', 'sf__Error', 'Email'], ['00Q1', 'INVALID_EMAIL_ADDRESS:Email: invalid', 'x'], ['00Q2', '', 'y'],
    ])
  })

  it('reads an empty answer as no lines', () => {
    expect(parseCsv('')).toEqual([])
  })

  it('refuses a quote that never closes, and a quote inside an unquoted field', () => {
    expect(() => parseCsv('a,"b\n')).toThrow(CsvError)
    expect(() => parseCsv('a,b"c\n')).toThrow(CsvError)
    expect(() => parseCsv('a,"b"c\n')).toThrow(CsvError)
  })
})
