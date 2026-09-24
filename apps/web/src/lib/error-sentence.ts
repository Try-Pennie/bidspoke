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
