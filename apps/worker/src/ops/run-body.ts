/**
 * What a run executes (#1950): the body invokeRun runs for one workflow
 * version's definition, the ops walk (run-walk.ts) with the step handlers
 * registered for the ops lane: app_action (app-action.ts, #2339), the one step
 * that reaches outside, through the ledgered send and connectionFetch, and the
 * walk's options: time sliced continuation (#1951, continuation.ts).
 */
import { appActionHandler, type AppActionDeps } from './app-action'
import type { RunBody } from './run-invocation'
import { walkOpsDefinition, type OpsStepHandler, type OpsWalkOptions } from './run-walk'

export interface OpsStepHandlerDeps {
  appAction: AppActionDeps
}

/** The handlers a live run walks with, by node type. */
export function opsStepHandlers(deps: OpsStepHandlerDeps): Readonly<Record<string, OpsStepHandler>> {
  return { app_action: appActionHandler(deps.appAction) }
}

/**
 * The body for one version: its definition walked with the secret values its
 * dispatch carried for this start (#2998), never kept; the walk takes the plain
 * values from what the run recorded at its first start (ctx.runVariables).
 */
export function runBodyFor(
  definition: Record<string, unknown>, secretValues: Readonly<Record<string, string>>, handlers: Readonly<Record<string, OpsStepHandler>>,
  options: Omit<OpsWalkOptions, 'secretValues'> = {},
): RunBody {
  return (ctx) => walkOpsDefinition(definition, ctx, handlers, { ...options, secretValues })
}
