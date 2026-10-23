/**
 * The ops executor for app_action (#2339, phase 9 of #1689): one catalogue
 * action (packages/service-catalogue) at the version the step pinned, sent
 * through the connection the step names.
 *
 * WHO RUNS IT. The ops run body (run-walk.ts) for a run the tick claimed, with
 * the run's RunContext, so every request it makes is a ledgered, fenced,
 * deadlined send (run-invocation.ts) before connectionFetch applies the login.
 *
 * WHOSE DATA. The run's organization: the connection is read through
 * connection_copy, which refuses another organization's row, and its login
 * opens only under that organization (connectionFetch). The step names its
 * connection by id; a value that is not an id, or a connection of another
 * service than the step names, is refused, never replaced (L75).
 *
 * ORDER.
 *  1. The step's settings and the pinned version (D1: never the newest), its
 *     arguments checked against that version's schema
 *     (@bidspoke/service-catalogue/schema step-config.ts, the reading the
 *     definition validator uses too), then its references resolved against the
 *     run. Each refusal names itself and sends nothing.
 *  2. The connection's copy, for the public target the action sends to.
 *  3. The action's run, its every request through run.send then
 *     connectionFetch. The action is handed the step's stable request id: the
 *     attempt key of the step's first send, the same on every attempt of the run.
 *
 * HOW A FAILURE ENDS THE RUN (failure.ts's outcomes, #1950's rules):
 *  - nothing sent, or the service refused (not_applied), or it applied and then
 *    failed (applied): the run fails, naming the code; repeating would not help,
 *    or would apply it twice;
 *  - unknown: an idempotent action is tried again, since its resend cannot apply
 *    twice; any other goes to a person (needs_human, send_outcome_unknown);
 *  - a GET past its deadline, or a copy that could not be read: tried again,
 *    since nothing was changed. invokeRun still fails a retry after a send that
 *    cannot be repeated, and itself ends a send that may have landed.
 *
 * WHAT IT RECORDS. Nothing but the send ledger row run.send writes before each
 * non GET send (method, host, the attempt key), which holds no header and no
 * body, so connectionFetch is told no request is recorded. A login is applied
 * after that and never reaches the step output, the ledger, the run's end or a
 * log line (__tests__/app-action.test.ts proves it with a known token).
 */
import { readAppActionConfig, readStepArgs, type ResolvedAction } from '@bidspoke/service-catalogue/schema'
import { ActionFailure, resolveRuntimeAction, type ActionArgs, type ActionContext, type JsonValue, type RuntimeAction } from '@bidspoke/service-catalogue/runtime'
import { resolveValue } from '../engine/context'
import { formatErr } from '../lib/format-error'
import type { StepExecutionResult } from '../types'
import { connectionFetch, type ConnectionCall, type ConnectionFetchDeps } from './connections/connection-fetch'
import { ConnectionRefusal, RequeueAt, type ConnectionRefusalCode } from './connections/refusals'
import { RunStopped, StepNotSent, StepTimedOut, stepRequestId, type ForwardAnswer } from './run-invocation'
import { StepEndsRun, type OpsStepHandler } from './run-walk'

export interface AppActionDeps {
  /**
   * connectionFetch's dependencies, rules included (one registry, services.ts).
   * Called only when a step reaches its connection, so a run with no app_action
   * never needs the ops connections key; throws naming what this deploy lacks.
   */
  connection(): ConnectionFetchDeps
  /** The run file for (key, version): resolveRuntimeAction, injected for tests. */
  resolveAction(key: string, version: number): ResolvedAction<RuntimeAction>
  /** Every wait an action makes (a poll's interval). */
  sleep(ms: number): Promise<void>
}

/**
 * connectionFetch refusals thrown after the request may have left: the deadline,
 * the caller giving up, a failure below HTTP. Every other refusal is decided
 * before anything is sent, or is an answer that applied nothing (a login
 * refused again after one renewal, a body that could not be sent again).
 */
const MAY_HAVE_LANDED: ReadonlySet<ConnectionRefusalCode> = new Set(['connection_timeout', 'connection_aborted', 'connection_network_error'])

const RECORDS_NOTHING = {
  recordsNothing: 'an ops run keeps no step input; the send ledger row run.send writes before each send (method, host, attempt key) is its record, and holds no header or body',
} as const

const fail = (error: string): StepExecutionResult => ({ output: null, error })

/** One request through connectionFetch, as the run's send forwards it. */
async function forwardThrough(deps: ConnectionFetchDeps, call: ConnectionCall, url: string, init: RequestInit): Promise<ForwardAnswer<Response>> {
  let answer: Response | RequeueAt
  try {
    answer = await connectionFetch(deps, call, url, init)
  } catch (err) {
    // The refusal's message is made of names alone (refusals.ts), so it may be recorded.
    if (err instanceof ConnectionRefusal && !MAY_HAVE_LANDED.has(err.code)) return { kind: 'not_sent', reason: err.message }
    throw err
  }
  if (answer instanceof RequeueAt) return { kind: 'requeue', notBefore: answer.notBefore, status: answer.status, cause: answer.cause }
  return { kind: 'answered', status: answer.status, value: answer }
}

export function appActionHandler(deps: AppActionDeps): OpsStepHandler {
  return async ({ node, ctx, run }) => {
    // 1. Settings, the pinned version, its arguments.
    const read = readAppActionConfig(node.config)
    if (!read.ok) return fail(`${read.reason}: ${read.message}`)
    const config = read.config
    const resolved = deps.resolveAction(config.action, config.actionVersion)
    if (!resolved.ok) return fail(`${resolved.reason}: ${resolved.message}`)
    const action = resolved.action
    const checked = readStepArgs(action, config.args)
    if (!checked.ok) return fail(checked.problems.map((p) => `${p.reason}: ${p.message}`).join('; '))
    const args: Record<string, unknown> = {}
    for (const declared of action.arguments) {
      if (!Object.hasOwn(checked.args, declared.key)) continue
      const value = declared.allowsVariables ? resolveValue(checked.args[declared.key], ctx) : checked.args[declared.key]
      if (value === undefined) return fail(`argument_unresolved: ${declared.key} refers to a value this run does not have`)
      if (declared.type === 'list' && !Array.isArray(value)) return fail(`argument_not_list: ${declared.key} must be a list`)
      args[declared.key] = value
    }

    // 2. The connection's copy, for its public target.
    let connection: ConnectionFetchDeps
    try {
      connection = deps.connection()
    } catch (err) {
      return fail(`ops_connections_not_configured: ${formatErr(err)}`)
    }
    let copy: Awaited<ReturnType<ConnectionFetchDeps['readCopy']>>
    try {
      copy = await connection.readCopy(run.run.organizationId, config.connection)
    } catch {
      throw new StepEndsRun({ outcome: 'retry', error: 'connection_copy_unreadable: the ops database did not answer the connection read, so nothing was sent' })
    }
    if (copy.state !== 'usable') return fail(`${copy.state === 'not_found' ? 'connection_not_found' : copy.state}: the step's connection cannot be used, so nothing was sent`)
    if (copy.service !== config.service) {
      return fail(`connection_service_mismatch: the step's connection is a ${copy.service ?? 'unknown'} connection, not ${config.service}, so nothing was sent`)
    }

    // 3. The action, every request through the ledgered send.
    let seq = 0
    const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
      const method = (init.method ?? 'GET').toUpperCase()
      const sent = await run.send<Response>({
        nodeId: node.id,
        seq: seq++,
        method,
        url,
        idempotent: action.idempotent,
        forward: ({ signal }) => forwardThrough(connection, {
          organizationId: run.run.organizationId,
          connectionId: config.connection,
          source: { kind: 'copy' },
          purpose: 'step',
          workflowId: run.run.workflowId,
          record: RECORDS_NOTHING,
          signal,
        }, url, { ...init, method }),
      })
      return sent.value
    }
    const actionCtx: ActionContext = {
      fetch,
      signal: run.signal,
      target: copy.target as JsonValue,
      sleep: (ms) => deps.sleep(ms),
      requestId: await stepRequestId(run.run.runRequestId, node.id, 0),
    }

    try {
      return { output: await action.run(actionCtx, args as ActionArgs) }
    } catch (err) {
      // An action may wrap the send's RunStopped in its own failure: the run's end is invokeRun's.
      if (err instanceof RunStopped || run.signal.aborted) throw new RunStopped()
      if (err instanceof StepTimedOut) throw new StepEndsRun({ outcome: 'retry', error: err.message })
      if (err instanceof StepNotSent) return fail(err.message)
      if (!(err instanceof ActionFailure)) return fail(formatErr(err))
      const named = `${err.code}: ${err.message}`
      if (err.outcome !== 'unknown' || seq === 0) return fail(named)
      if (action.idempotent) throw new StepEndsRun({ outcome: 'retry', error: named })
      throw new StepEndsRun({ outcome: 'needs_human', reason: 'send_outcome_unknown', error: `${named}; it may have been applied` })
    }
  }
}

/** The live deps but the connection, which run-live.ts builds from the Worker's env. */
export function appActionDeps(connection: () => ConnectionFetchDeps): AppActionDeps {
  let built: ConnectionFetchDeps | null = null
  return {
    connection: () => (built ??= connection()),
    resolveAction: resolveRuntimeAction,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}
