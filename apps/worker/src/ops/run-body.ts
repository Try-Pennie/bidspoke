/**
 * What a run executes (#1950): the body invokeRun runs for one workflow
 * version's definition, the ops walk (run-walk.ts) with the step handlers
 * registered for the ops lane: app_action (app-action.ts, #2339), the one step
 * that reaches outside, through the ledgered send and connectionFetch.
 */
import { appActionHandler, type AppActionDeps } from './app-action'
import type { RunBody } from './run-invocation'
import { walkOpsDefinition, type OpsStepHandler } from './run-walk'

export interface OpsStepHandlerDeps {
  appAction: AppActionDeps
}

/** The handlers a live run walks with, by node type. */
export function opsStepHandlers(deps: OpsStepHandlerDeps): Readonly<Record<string, OpsStepHandler>> {
  return { app_action: appActionHandler(deps.appAction) }
}

export function runBodyFor(definition: Record<string, unknown>, handlers: Readonly<Record<string, OpsStepHandler>>): RunBody {
  return (ctx) => walkOpsDefinition(definition, ctx, handlers)
}
