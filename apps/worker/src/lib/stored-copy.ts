/**
 * The warning an edit route adds to its normal answer when its row was saved
 * but a stored copy of the old version (a cache, or a last-good copy served in
 * a database outage) could not be refreshed or cleared (#1845, #1846).
 *
 * The refresh runs right after the commit and never throws, so the route's
 * other work (deploy, audit) always runs, and the save is reported as the
 * success it was, with this beside it. Saving again retries the refresh.
 */
export const COPY_NOT_CLEARED_MESSAGE =
  'The change was saved and recorded, but a stored copy of the old version could not be refreshed, so the old version may still be served for a few minutes, and during a database outage until it is cleared. Save it again to clear it.'

/**
 * Runs a stored copy's refresh or retirement, answering false (with the failure
 * logged) when it throws, so the route carries on with its other work and adds
 * copyWarning to its answer. The call is written at the call site, where the
 * copy guards read it.
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

/** The field a route spreads into its answer: empty when the copy was refreshed. */
export function copyWarning(refreshed: boolean): { stored_copy_warning?: string } {
  return refreshed ? {} : { stored_copy_warning: COPY_NOT_CLEARED_MESSAGE }
}
