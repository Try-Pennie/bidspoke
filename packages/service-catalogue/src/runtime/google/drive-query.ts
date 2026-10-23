import { ActionFailure } from '../failure'
import type { JsonValue } from '../types'
import { invalid } from './call'

/**
 * A step's values in a Drive files.list query (#2337). The query is the step's
 * own text and takes no variables; a value reaches it only as a `?` bind,
 * written as a Drive query literal (Drive API, "Search for files and folders":
 * a string in single quotes with \' and \\ escaped; true and false bare), so no
 * value can become query text. A `?` inside a quoted string is text.
 */

function literal(value: JsonValue, place: number): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`
  throw invalid(`bind ${place} must be text or a boolean`)
}

export function bindDriveQuery(query: string, binds: JsonValue | undefined): string {
  if (binds !== undefined && binds !== null && !Array.isArray(binds)) throw invalid('binds must be a list, one value for each ? in the query')
  const values = (binds ?? []) as readonly JsonValue[]
  let out = ''
  let used = 0
  let inString = false
  for (let i = 0; i < query.length; i++) {
    const c = query[i]
    if (inString) {
      out += c
      if (c === '\\' && i + 1 < query.length) out += query[++i]
      else if (c === '\'') inString = false
    } else if (c === '\'') {
      inString = true
      out += c
    } else if (c === '?') {
      if (used >= values.length) throw new ActionFailure('google_binds_mismatch', `the query has more ? placeholders than the ${values.length} binds given`, 'not_applied')
      out += literal(values[used], used + 1)
      used++
    } else {
      out += c
    }
  }
  if (inString) throw invalid('the query has a quoted string that never ends')
  if (used !== values.length) throw new ActionFailure('google_binds_mismatch', `the query has ${used} ? placeholders and the step gave ${values.length} binds`, 'not_applied')
  return out
}
