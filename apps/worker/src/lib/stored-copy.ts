/**
 * What an edit route answers when its row was saved and audited but a stored
 * copy of the old version (a cache, or a last-good copy served in a database
 * outage) could not be refreshed or cleared (#1845, #1846).
 *
 * The copy is handled last, after the audit and the route's other work, so a
 * KV failure here never leaves a saved change unrecorded. Saving again retries it.
 */
export const COPY_NOT_CLEARED_MESSAGE =
  'The change was saved and recorded, but a stored copy of the old version could not be refreshed, so the old version may still be served for a few minutes, and during a database outage until it is cleared. Save it again to clear it.'

/**
 * Runs a stored copy's refresh or retirement, answering false (with the failure
 * logged) when it throws, so the route can answer COPY_NOT_CLEARED_MESSAGE
 * instead of throwing past its audit. The call is written at the call site,
 * where the copy guards read it.
 */
export async function copyCleared(work: () => Promise<void>, what: string): Promise<boolean> {
  try {
    await work()
    return true
  } catch (err) {
    console.error(`[stored-copy] ${what} could not be refreshed: ${err instanceof Error ? err.message : 'unknown error'}`)
    return false
  }
}
