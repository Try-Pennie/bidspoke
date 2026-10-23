import { ActionFailure } from '../failure'
import type { JsonValue } from '../types'

/**
 * A step's values in a SOQL query (#2337). The query is the step's own text and
 * takes no variables; a value reaches it only as a `?` bind, written here as a
 * SOQL literal, so no value can become query text: a name with a quote in it
 * stays one string. Pipedream interpolated values into the query as given,
 * which let a value close its string and add a clause; this is the one
 * deliberate difference of the parity action.
 *
 * The REST API has no bind parameters of its own, so a string is written with
 * Salesforce's quoted string escapes (SOQL and SOSL Reference, "Quoted String
 * Escape Sequences": \n \r \t \b \f \" \' \\). A number is written as it is
 * (never an exponent, which SOQL does not read), a boolean as true or false, a
 * null as null, a list of those as an IN list, and a date or date time only as
 * `{ "date": "YYYY-MM-DD" }` or `{ "datetime": "YYYY-MM-DDThh:mm:ss(.sss)Z" }`,
 * checked and written unquoted, since a quoted one is a string. Anything else
 * is refused, never guessed at.
 *
 * A `?` inside a quoted string of the query is text, not a placeholder.
 */

const invalid = (message: string) => new ActionFailure('salesforce_argument_invalid', message, 'not_applied')

const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/

const ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\', '\'': '\\\'', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f',
}

function isObject(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scalar(value: JsonValue, place: number): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    const text = String(value)
    if (!Number.isFinite(value) || /e/i.test(text)) throw invalid(`bind ${place} is a number SOQL cannot read as written`)
    return text
  }
  if (typeof value === 'string') return `'${value.replace(/[\\'"\n\r\t\b\f]/g, (c) => ESCAPES[c])}'`
  if (isObject(value)) {
    const keys = Object.keys(value)
    if (keys.length === 1 && keys[0] === 'date' && typeof value.date === 'string' && DATE.test(value.date)) return value.date
    if (keys.length === 1 && keys[0] === 'datetime' && typeof value.datetime === 'string' && DATETIME.test(value.datetime)) return value.datetime
    throw invalid(`bind ${place} is an object that is not { "date": "YYYY-MM-DD" } or { "datetime": "YYYY-MM-DDThh:mm:ssZ" }`)
  }
  throw invalid(`bind ${place} is a list inside a list`)
}

function literal(value: JsonValue, place: number): string {
  if (Array.isArray(value)) {
    if (value.length === 0) throw invalid(`bind ${place} is an empty list, which SOQL cannot write as an IN list`)
    return `(${(value as readonly JsonValue[]).map((v) => scalar(v, place)).join(', ')})`
  }
  return scalar(value, place)
}

/** The `?` placeholders outside quoted strings, by position, or a refusal of a string that never ends. */
function placeholders(query: string): number[] {
  const at: number[] = []
  let inString = false
  for (let i = 0; i < query.length; i++) {
    const c = query[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '\'') inString = false
    } else if (c === '\'') {
      inString = true
    } else if (c === '?') {
      at.push(i)
    }
  }
  if (inString) throw new ActionFailure('salesforce_query_invalid', 'the query has a quoted string that never ends', 'not_applied')
  return at
}

/** The query with each `?` replaced by its bind as a SOQL literal. */
export function bindSoql(query: string, binds: JsonValue | undefined): string {
  if (binds !== undefined && binds !== null && !Array.isArray(binds)) throw invalid('binds must be a list, one value for each ? in the query')
  const values = (binds ?? []) as readonly JsonValue[]
  const at = placeholders(query)
  if (at.length !== values.length) {
    throw new ActionFailure('salesforce_binds_mismatch', `the query has ${at.length} ? placeholders and the step gave ${values.length} binds`, 'not_applied')
  }
  let out = ''
  let from = 0
  at.forEach((position, i) => {
    out += query.slice(from, position) + literal(values[i], i + 1)
    from = position + 1
  })
  return out + query.slice(from)
}
