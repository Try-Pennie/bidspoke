/**
 * Unit test setup: no test ends with work it handed to waitUntil still running (#2120).
 *
 * Runs after every test of every worker unit file, after the file's own
 * afterEach hooks. Every recordingContext() the file made is checked: work
 * still running when the test ended fails that test, by name, and is let
 * finish first either way, so it cannot log into a closed worker and fail the
 * whole run with every test green. The mechanism is in ./wait-until.ts.
 */
import { afterEach } from 'vitest'
import { SETTLE_TIMEOUT_MS, settleAfterTest } from './wait-until'

afterEach(async () => {
  const problem = await settleAfterTest()
  if (problem) throw new Error(problem)
}, SETTLE_TIMEOUT_MS * 3)
