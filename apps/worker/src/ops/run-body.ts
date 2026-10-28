/**
 * What a run executes (#1950): the body invokeRun runs for one workflow
 * version's definition, the ops walk (run-walk.ts) with the step handlers
 * registered for the ops lane: app_action (app-action.ts, #2339), the one step
 * that reaches outside, through the ledgered send and connectionFetch, and the
 * walk's options: time sliced continuation (#1951, continuation.ts).
 */
import type { OpsVersionVariables } from '../lib/ops-gateway-contract'
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
 * The body for one version: its definition walked with the variables kept with
 * it (#2702), which a live run always names, null for a version that kept none.
 */
export function runBodyFor(
  definition: Record<string, unknown>, variables: OpsVersionVariables | null, handlers: Readonly<Record<string, OpsStepHandler>>,
  options: Omit<OpsWalkOptions, 'variables'> = {},
): RunBody {
  return (ctx) => walkOpsDefinition(definition, ctx, handlers, { ...options, variables })
}
