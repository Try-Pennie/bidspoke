/**
 * The module state in the Worker's source that the outage drill (#1305) forgets
 * before every run, as `path:name`. harness/isolate-memory.ts maps each to the
 * function that forgets it, and lib/__tests__/isolate-memory.test.ts fails on any
 * module-level state that is neither here nor kept with a reason.
 */
export const FORGOTTEN_STATE = [
  // A down run would otherwise be answered from the constants the up run loaded,
  // and never meet the outage.
  'src/lib/partner-constants-loader.ts:inflight',
  'src/lib/partner-constants-loader.ts:memoryCache',
  // A warm run would otherwise skip writing the partner copy a previous fixture
  // wrote, though reset() removed that copy.
  'src/lib/partner-last-good.ts:lastGoodWritten',
  // The count of stored copies served (#1848): a down run adds to it, and it is
  // flushed per request, so one fixture's counts must not carry into the next.
  'src/lib/stored-copy-ledger.ts:flushing',
  'src/lib/stored-copy-ledger.ts:isolateId',
  'src/lib/stored-copy-ledger.ts:lastFlushAt',
  'src/lib/stored-copy-ledger.ts:pending',
  // The row cap reports already sent to Better Stack (#1436): a run would
  // otherwise skip a report a previous fixture's read had sent.
  'src/lib/row-cap.ts:lastSent',
  'src/lib/row-cap.ts:saidUnconfigured',
] as const

export type ForgottenState = (typeof FORGOTTEN_STATE)[number]
