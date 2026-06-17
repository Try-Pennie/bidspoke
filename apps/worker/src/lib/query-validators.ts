// Validators for query-param values that get interpolated into a PostgREST
// filter string (e.g. the keyset cursor in the .or() on /api/executions). A raw
// value containing ',' or '(' breaks the filter grammar (500) or injects extra
// OR branches, so anything fed into such a string must be a well-formed
// timestamp / UUID first (#106).

// ISO-8601 timestamp as PostgREST serializes timestamptz: date, 'T' or space,
// time, optional fractional seconds, optional timezone. Crucially rejects
// commas and parentheses.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?([+-]\d{2}:?\d{2}|[+-]\d{2}|Z)?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isIsoTimestamp(v: string | undefined | null): v is string {
  return typeof v === 'string' && ISO_TIMESTAMP.test(v)
}

export function isUuid(v: string | undefined | null): v is string {
  return typeof v === 'string' && UUID.test(v)
}
