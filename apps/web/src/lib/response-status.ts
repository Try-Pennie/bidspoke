// Author-time check for a Response node whose status is a hard-coded 4xx (#325).
// A 4xx returned to a lead source can be read as a PERMANENT rejection: some
// sources stop retrying on any 4xx, so a soft/temporary rejection sent as a 4xx
// silently drops a retryable lead. This predicate drives an editor warning that
// asks the author to confirm the 4xx is an intentional permanent rejection.
//
// Templates ({{...}}) resolve at run time and are unknowable at author time, so
// they are not flagged. The Response config stores a plain number for numeric
// entries and a string for templates, but we accept a numeric string too.

export function isHardCoded4xx(statusCode: unknown): boolean {
  if (typeof statusCode === 'number') {
    return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 499
  }
  if (typeof statusCode === 'string') {
    if (statusCode.includes('{{')) return false // template — resolved at run time
    const trimmed = statusCode.trim()
    const n = parseInt(trimmed, 10)
    return String(n) === trimmed && n >= 400 && n <= 499
  }
  return false
}
