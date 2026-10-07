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
] as const

export type ForgottenState = (typeof FORGOTTEN_STATE)[number]
