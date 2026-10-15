/**
 * Unit test setup: the cron guard recorder's backoff takes no real time (#2166, L524).
 *
 * Every test file that fires the real scheduled handler without a working KV
 * binding sends each fail-open's record through the isolate recorder, which
 * retries after 250 ms and 1,000 ms before holding the event. This swaps the
 * singleton for one whose sleep returns at once, for every file, so none of
 * them waits for real and none leaves a backoff running past its teardown. The
 * retry schedule itself is asserted in cron-guard-record.test.ts with its own
 * injected sleep. src/__tests__/no-real-guard-backoff.test.ts proves this holds.
 */
import { vi } from 'vitest'

vi.mock('../lib/cron-guard-record', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/cron-guard-record')>()
  return { ...real, isolateCronGuardRecorder: real.createCronGuardRecorder({ sleep: () => Promise.resolve() }) }
})
