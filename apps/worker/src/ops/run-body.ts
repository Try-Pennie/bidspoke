/**
 * What a run executes (#1950): the body invokeRun runs for one workflow
 * version's definition, the ops walk (run-walk.ts) with the step handlers
 * registered for the ops lane (OPS_STEP_HANDLERS, where #2339 adds app_action).
 */
import type { RunBody } from './run-invocation'
import { OPS_STEP_HANDLERS, walkOpsDefinition } from './run-walk'

export function runBodyFor(definition: Record<string, unknown>): RunBody {
  return (ctx) => walkOpsDefinition(definition, ctx, OPS_STEP_HANDLERS)
}
