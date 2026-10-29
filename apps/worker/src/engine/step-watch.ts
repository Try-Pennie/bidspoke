/**
 * One step's at-risk watch and write marker, carried with the step's own call
 * (#2832).
 *
 * A post-answer Salesforce update is watched around its whole retry loop and
 * stamped with its write marker (#2022, #2023), and a credit inquiry post is
 * recorded before it is sent (#2172). The Salesforce node reaches those through
 * three hooks it reads from the context it is called with: `noteSalesforceRequest`,
 * `recordSalesforceRequest` and `writeMarker`.
 *
 * Those hooks used to be fields of the run's one shared context, set by the walk
 * for the step it was on. That held only while one watched step ran at a time,
 * so the children of a parallel block ran unwatched: an inquiry post placed in
 * one went out with no record, and nothing said so. Now every step is called
 * with its own view of the context. The view holds that step's three hooks and
 * passes every other read and write through to the run's context, so what a
 * node writes there (a block sighting, say) still reaches the walk, and two
 * children writing at once each keep their own hooks.
 *
 * Both of the engine's step loops (the walk's and a parallel child's) run a step
 * through `runWatchedStep`, so the two cannot disagree about which steps are
 * watched.
 */
import type { ExecutionContext, NodeDefinition, ResolvedStepInput } from '../types'
import { startWatchSafely, runWatched, type AtRiskWatch } from './at-risk-writes'
import { isCreditInquiryPost } from './inquiry-post'
import { writeMarker, withWriteMarker, ENGINE_ATTEMPT } from './write-marker'
import { carryStepInput } from './step-input'

/** The hooks a step carries with its call, never shared with another step. */
export interface StepHooks {
  noteSalesforceRequest?: ExecutionContext['noteSalesforceRequest']
  recordSalesforceRequest?: ExecutionContext['recordSalesforceRequest']
  writeMarker?: ExecutionContext['writeMarker']
  noteStepInput?: ExecutionContext['noteStepInput']
}

const HOOK_KEYS: ReadonlySet<string | symbol> = new Set<keyof StepHooks>(['noteSalesforceRequest', 'recordSalesforceRequest', 'writeMarker', 'noteStepInput'])

/**
 * A view of the run's context for one step: the step's hooks are its own, and
 * everything else is the run's context itself, read and written through.
 */
export function stepContext(ctx: ExecutionContext, hooks: StepHooks): ExecutionContext {
  return new Proxy(ctx, {
    get: (target, key, receiver): unknown => (HOOK_KEYS.has(key) ? hooks[key as keyof StepHooks] : Reflect.get(target, key, receiver)),
    set: (target, key, value: unknown) => {
      if (HOOK_KEYS.has(key)) {
        ;(hooks as Record<string, unknown>)[key as string] = value
        return true
      }
      return Reflect.set(target, key, value)
    },
    has: (target, key) => HOOK_KEYS.has(key) || Reflect.has(target, key),
    // A node that copies its context ({ ...ctx }) keeps the step's hooks in the copy.
    ownKeys: (target) => [...new Set([...Reflect.ownKeys(target), ...HOOK_KEYS])],
    getOwnPropertyDescriptor: (target, key) =>
      HOOK_KEYS.has(key)
        ? { value: hooks[key as keyof StepHooks], writable: true, enumerable: true, configurable: true }
        : Reflect.getOwnPropertyDescriptor(target, key),
  })
}

/**
 * Runs one step under its watch, with its own hooks. `work` is called with the
 * step's view of the context, which is what the node must be called with.
 *
 * A Salesforce update after the answer is watched around its whole retry loop,
 * so one still out after 2 s is recorded however it ends (#2022), and carries its
 * own write marker for the read-back (#2023). One fact decides both, the same one
 * the Salesforce bulkhead share reads (#2170): `ctx.afterAnswer`, set by
 * `answerEarly` together with the answer. A credit inquiry post is watched before
 * or after the answer (#2172, D5): it is never resent blind, and its watch
 * records it before it is sent.
 *
 * Every step may also note the request it resolved (`noteStepInput`, #3057), and
 * a failure carrying no request of its own is given the last one noted, so a
 * step that timed out still records what it sent. It is put on outside the
 * at-risk watch, which has already given a Salesforce failure its own request
 * by then; the Salesforce node notes nothing here.
 */
export async function runWatchedStep<T>(
  ctx: ExecutionContext,
  node: Pick<NodeDefinition, 'type' | 'namespace' | 'config'>,
  work: (stepCtx: ExecutionContext) => Promise<T>,
  retries: () => number,
): Promise<T> {
  const postAnswerUpdate = ctx.afterAnswer === true && node.type === 'salesforce' && node.config.operation === 'update'
  const inquiryPost = node.type === 'salesforce' && isCreditInquiryPost(node.config)
  const atRisk: AtRiskWatch | null = postAnswerUpdate || inquiryPost ? startWatchSafely(ctx.startAtRiskWatch, node.namespace) : null
  const marker = postAnswerUpdate && ctx.execution?.execution_id
    ? writeMarker(ctx.execution.execution_id, node.namespace, ENGINE_ATTEMPT) ?? undefined
    : undefined
  // The last request the step noted: on a retry, the attempt that failed last.
  let notedInput: ResolvedStepInput | null = null
  const hooks: StepHooks = { noteStepInput: (input) => { notedInput = input } }
  const stepCtx = stepContext(ctx, hooks)
  try {
    return await withWriteMarker(stepCtx, marker, () => runWatched(
      atRisk,
      (note) => {
        hooks.noteSalesforceRequest = note
        // The credit inquiry post records at once, through the same watch (#2172).
        hooks.recordSalesforceRequest = note && atRisk ? (req) => atRisk.recordNow(req) : undefined
      },
      () => work(stepCtx),
      retries,
    ))
  } catch (err) {
    throw carryStepInput(err, notedInput)
  }
}
