/**
 * The sentence to show a person for a failed request (#1557). req() puts the
 * body's `error` in the thrown message, and several routes answer a machine code
 * there with the sentence in `message` (`{ error: 'click_count_unavailable',
 * message: 'The click counter did not answer...' }`), so showing err.message puts
 * the code on the page. This reads the body's sentence first, then the message,
 * then the caller's fallback.
 *
 * Kept apart from api.ts so the many tests that mock '@/lib/api' whole still get
 * the real function.
 */
export function errorSentence(err: unknown, fallback: string): string {
  const body = (err as { body?: unknown } | null)?.body
  const sentence = body && typeof body === 'object' ? (body as { message?: unknown }).message : undefined
  if (typeof sentence === 'string' && sentence.trim() !== '') return sentence
  if (err instanceof Error && err.message.trim() !== '') return err.message
  return fallback
}

/**
 * Why a request failed, as words that can follow "Nothing saved:" (#2322,
 * PM-19): the route's own sentence when it sent one; otherwise the cause the
 * client measured (a timeout by its ceiling, a server error by its status, no
 * answer at all); otherwise the caller's words. Never err.message, which for a
 * failed request is the server's bare code ("Service unavailable"), not a
 * reason (L11). Read by shape, since tests mock '@/lib/api' whole.
 */
export function requestFailureCause(err: unknown, fallback = 'the request failed'): string {
  const e = (err ?? {}) as { body?: unknown; timedOut?: unknown; timeoutMs?: unknown; status?: unknown }
  const sentence = e.body && typeof e.body === 'object' ? (e.body as { message?: unknown }).message : undefined
  if (typeof sentence === 'string' && sentence.trim() !== '') return sentence
  if (e.timedOut === true && typeof e.timeoutMs === 'number') return `the server did not answer within ${Math.round(e.timeoutMs / 1000)} seconds`
  if (typeof e.status === 'number') return `the server answered with an error (HTTP ${e.status})`
  if (err instanceof TypeError) return 'the server could not be reached'
  return fallback
}

/** A cause from requestFailureCause as a sentence of its own: capitalised, with its full stop. */
export function causeAsSentence(cause: string): string {
  const s = cause.charAt(0).toUpperCase() + cause.slice(1)
  return /[.!?]$/.test(s) ? s : `${s}.`
}
