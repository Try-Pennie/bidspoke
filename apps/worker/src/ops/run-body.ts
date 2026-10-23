/**
 * What a run executes (#1950): the body invokeRun runs for one workflow version's
 * definition. PR 5 of B3 walks the definition with the ops lane executor, every
 * egress through ctx.send; until it lands, no ops executor exists, so a run
 * started in live mode ends failed by name rather than doing anything. The tick
 * ships in observe mode, which claims and starts nothing, so this is reached
 * only once Dan switches the tick to live.
 */
import type { RunBody } from './run-invocation'

export const NO_EXECUTOR_ERROR = 'no ops executor runs a workflow definition yet (#1950 PR 5), so the run did nothing and ended failed'

export function runBodyFor(_definition: Record<string, unknown>): RunBody {
  return () => Promise.resolve({ outcome: 'failed', error: NO_EXECUTOR_ERROR })
}
