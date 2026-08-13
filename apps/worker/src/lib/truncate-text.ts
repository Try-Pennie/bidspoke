/**
 * Truncate text to `max` characters WITHOUT dropping the tail.
 *
 * Error text puts its most searchable token at the very end: a SQLSTATE code, a
 * PostgREST code, or (for an upstream HTML error page) the request-ID stamp and
 * the pod name. Slicing only the head cuts exactly that off, so keep both ends
 * and mark the join. Shared by formatErr's alert budget and the HTML error-page
 * summarizer, which have different budgets but the same requirement.
 */
export const TRUNCATION_ELLIPSIS = ' … '

export function truncateKeepingTail(text: string, max: number, tailChars: number): string {
  if (text.length <= max) return text
  const headLen = Math.max(0, max - tailChars - TRUNCATION_ELLIPSIS.length)
  return text.slice(0, headLen) + TRUNCATION_ELLIPSIS + text.slice(text.length - tailChars)
}
