// Code node — user-defined JS executed in a sandboxed Dynamic Worker.
// On workflow save, all code scripts are deployed into a single bundled worker
// per workflow (one dispatch worker, path-routed by namespace). This executor
// dispatches to /execute/{namespace} on that bundle. If the bundle is missing
// or doesn't contain this namespace (migration in progress), it falls back to
// the legacy per-node worker.

import type { NodeDefinition, ExecutionContext, StepExecutionResult, StepOutput, ResolvedStepInput } from '../../types'
import type { Env } from '../../index'
import { codeBundleName, codeWorkerName, isWorkerNotFoundError } from '../../lib/code-node-deployer'
import { formatErr } from '../../lib/format-error'
import { parseCodeSandboxResponse, type SandboxBlockRecord } from '../code-response'
import { noteBlockSighting, sightingFromResponse } from '../block-sightings'

/**
 * Bundles built before the sandbox recorded non-2xx responses (#1265) answer with no
 * `blocks` key at all, which would otherwise read exactly like a bundle that saw nothing.
 * Counted once per bundle per isolate so coverage is measurable in the logs, and the
 * post-deploy check is "this line reaches zero", not "no blocks were seen".
 */
const bundlesWithoutCapture = new Set<string>()

export function noteSandboxBlocks(
  ctx: ExecutionContext,
  namespace: string,
  bundleName: string,
  records: SandboxBlockRecord[] | undefined,
): void {
  if (records === undefined) {
    if (!bundlesWithoutCapture.has(bundleName)) {
      bundlesWithoutCapture.add(bundleName)
      console.log(`[code-node] event=code_bundle_without_block_capture workflow=${ctx.trigger.workflow_id} bundle=${bundleName} namespace=${namespace}`)
    }
    return
  }
  for (const r of records) {
    const headers = {
      get: (name: string) => (name === 'cf-ray' ? r.cfRay : name === 'cf-mitigated' ? r.cfMitigated : name === 'content-type' ? r.contentType : null),
    }
    noteBlockSighting(ctx, sightingFromResponse(r.url, r.status, r.bodyHead, headers, `code:${namespace}`))
  }
}
import { hasDynamicStepsAccess, extractReferencedNamespaces } from '@bidspoke/references'
import { buildSandboxEnv } from '../../lib/sandbox-env'
import { resolveValue } from '../context'

/**
 * Builds the Results-panel "Input" shape for a code node:
 *   template: the props config the author wrote (with template strings intact)
 *   resolved: the resolved prop values + referenced step namespaces
 *
 * Excludes the script source (visible in the editor above) and the filtered
 * steps payload (visible on each upstream step's own row).
 *
 * Exported so the chained-code path in walkGraph can synthesize the same shape
 * without re-implementing the prop resolution logic.
 */
export function buildCodeStepInput(node: NodeDefinition, ctx: ExecutionContext): ResolvedStepInput {
  const propsConfig = (node.config?.props ?? []) as Array<{ name: string; source: string }>
  const resolvedProps: Record<string, unknown> = {}
  for (const p of propsConfig) {
    if (!p?.name || !p?.source) continue
    resolvedProps[p.name] = resolveValue(p.source, ctx)
  }
  const script = (node.config?.script as string | undefined) ?? ''
  const referenced = extractReferencedSteps(script)
  return {
    template: { props: propsConfig },
    resolved: {
      props: resolvedProps,
      steps_referenced: referenced === null ? 'all (dynamic access)' : Array.from(referenced),
    },
  }
}

/**
 * Re-exported from the shared reference parser (#433), which is where this rule
 * now lives so the engine's step-scoping and the watched-field scanner cannot
 * drift apart about what counts as unreadable. Kept as an export here because
 * existing callers import it from this module.
 */
export { hasDynamicStepsAccess }

/**
 * Static-analyzes a user script for `steps.X` dot references and returns the
 * set of step namespaces referenced. Used to filter the `steps` object we
 * pass to the dispatched code worker — without this, every code node subrequest
 * carries the full accumulated step context (credit reports, trade analyses,
 * etc.) even when the script only touches one or two steps.
 *
 * Returns null when the script uses dynamic access patterns that make static
 * analysis unsafe (bracket access, aliasing). Caller should fall back to
 * sending the full steps object.
 *
 * Heuristics:
 * - `steps["foo"]` / `steps[something]` → bail (dynamic key)
 * - `const X = steps` (whole-object assignment) → bail (aliasing)
 * - `Object.keys(steps)` / `Object.entries(steps)` → bail (iteration)
 * - `for (const k in steps)` → bail (iteration)
 * - Everything else → scan for `steps.<ident>` dot references
 */
function extractReferencedSteps(script: string): Set<string> | null {
  return extractReferencedNamespaces(script)
}

/**
 * Union of the step namespaces referenced across a chain's scripts (#190). The
 * chain path runs several code nodes in one bundle dispatch and used to hand them
 * the full step context. Here we collect what they collectively reference so only
 * those steps are sent. If ANY script uses a dynamic access pattern
 * (extractReferencedSteps → null), we can't statically scope the chain, so the
 * whole union is null = send everything (the safe fallback).
 */
export function unionReferencedSteps(scripts: string[]): Set<string> | null {
  const union = new Set<string>()
  for (const script of scripts) {
    const refs = extractReferencedSteps(script ?? '')
    if (refs === null) return null
    for (const r of refs) union.add(r)
  }
  return union
}

/**
 * Build the `steps` object to hand a code sandbox, scoped to `referenced` (#190).
 * null → send every step (dynamic access fallback); otherwise only the referenced
 * namespaces. `trigger` is always included (as { payload }) and never duplicated
 * from the referenced set. Shared by the single-node and chain paths.
 */
export function scopeSteps(
  ctxSteps: Record<string, StepOutput>,
  triggerPayload: unknown,
  referenced: Set<string> | null,
): Record<string, StepOutput | { payload: unknown }> {
  const trigger = { payload: triggerPayload }
  if (referenced === null) return { ...ctxSteps, trigger }
  const filtered: Record<string, StepOutput | { payload: unknown }> = {}
  for (const ns of referenced) {
    if (ns === 'trigger') continue
    const entry = ctxSteps[ns]
    if (entry) filtered[ns] = entry
  }
  filtered.trigger = trigger
  return filtered
}

export async function executeCodeNode(
  node: NodeDefinition,
  ctx: ExecutionContext,
  env: Env,
  signal?: AbortSignal
): Promise<StepExecutionResult> {
  const script = (node.config?.script as string | undefined)?.trim()
  if (!script) {
    throw new Error(`Code node "${node.namespace}" has no script configured`)
  }

  // Withhold platform master secrets from the sandbox; partner creds + DB env
  // vars (decrypted by env-loader) still flow (#108).
  const mergedEnv = buildSandboxEnv(env, ctx.env)

  // Filter the steps payload to only what this script actually references.
  // For workflows like engine bidding where Equifax/trade responses are 20-80KB
  // each, skipping unused steps cuts subrequest payload size by 60-80% and
  // shaves measurable time off JSON stringify + network + parse on the worker.
  const referenced = extractReferencedSteps(script)
  const stepsToSend = scopeSteps(ctx.steps, ctx.trigger.payload, referenced)

  // Resolve per-node props (Pipedream-style declared inputs). The script
  // receives them as a `props` global. Sources are templated against the
  // execution context (steps.X, payload.Y, env.Z, execution.*).
  const propsConfig = (node.config?.props ?? []) as Array<{ name: string; source: string }>
  const resolvedProps: Record<string, unknown> = {}
  for (const p of propsConfig) {
    if (!p?.name || !p?.source) continue
    resolvedProps[p.name] = resolveValue(p.source, ctx)
  }

  // Captured for the Results panel. Built once here so both the throw path
  // (attach to err) and the happy path (return in result) use identical data.
  const resolvedInput: ResolvedStepInput = {
    template: { props: propsConfig },
    resolved: {
      props: resolvedProps,
      steps_referenced: referenced === null ? 'all (dynamic access)' : Array.from(referenced),
    },
  }

  const body = buildCodeSandboxBody(ctx, stepsToSend, mergedEnv, resolvedProps)

  const res = await dispatchWithFallback(env, ctx.trigger.workflow_id, node.namespace, body, ctx.codeBundleName, signal)
  const text = await res.text()

  // One shared parser for both dispatch paths (see engine/code-response.ts):
  // it unwraps the {__bsv: 1, output, logs} envelope and decides output-vs-error
  // from res.ok alone, so an error body can never be read as output (#460).
  const parsedRes = parseCodeSandboxResponse(res.ok, text)
  noteSandboxBlocks(ctx, node.namespace, ctx.codeBundleName ?? codeBundleName(ctx.trigger.workflow_id), parsedRes.blocks)

  if (!parsedRes.ok) {
    const err = new Error(parsedRes.error) as Error & {
      logs?: import('../../types').StepLogEntry[]
      resolvedInput?: ResolvedStepInput
      codeErrorName?: string
    }
    if (parsedRes.logs) err.logs = parsedRes.logs
    // Carry the thrown error's constructor name so the classifier can fail a
    // deterministic programming error fast instead of retrying it (#458).
    if (parsedRes.errorName !== undefined) err.codeErrorName = parsedRes.errorName
    err.resolvedInput = resolvedInput
    throw err
  }

  const output: unknown = parsedRes.output
  const logs = parsedRes.logs

  return { output, ...codeSentinel(output), logs, resolvedInput }
}

/**
 * The early exit sentinels translated Pipedream code emits, read from a code
 * node's returned value:
 *   $.respond({...})  → return { response: { status, body, headers? } }
 *   $.flow.exit(...)  → return { exit: true, reason: ... }
 * ANY returned object with a non null object `response` field is a respond
 * sentinel and ends the walk there, so a kept script must never return a field
 * of that name for any other purpose (the Liberty1 click patch did, 2026-09-29:
 * the portal got an empty answer and the Salesforce writes never ran).
 * Exported so tests that stand in for the sandbox apply the same rule.
 */
export function codeSentinel(output: unknown): Pick<StepExecutionResult, 'earlyResponse' | 'continueAfterResponse' | 'expected' | 'earlyExit'> {
  if (output === null || typeof output !== 'object') return {}
  const obj = output as Record<string, unknown>
  if ('response' in obj && obj.response !== null && typeof obj.response === 'object') {
    const r = obj.response as { status?: number; body?: unknown; headers?: Record<string, string> }
    const expected = obj.expected === true ? (true as const) : undefined
    const earlyResponse = { status: r.status ?? 200, body: r.body ?? null, headers: r.headers }
    return obj.continueExecution === true ? { earlyResponse, continueAfterResponse: true, expected } : { earlyResponse, expected }
  }
  if (obj.exit === true) return { earlyExit: true }
  return {}
}

/**
 * Build the JSON request body sent to the code sandbox. Extracted so the
 * shadow_mode contract is unit-testable without dispatching a real isolate.
 * Outbound code scripts read `shadow_mode` and self-stub on 'dry_run' — the
 * engine can't introspect the sandbox. See docs/engine-cutover-scope.md 3.3.
 */
export function buildCodeSandboxBody(
  ctx: ExecutionContext,
  stepsToSend: Record<string, StepOutput | { payload: unknown }>,
  mergedEnv: Record<string, string>,
  resolvedProps: Record<string, unknown>,
): string {
  return JSON.stringify({
    payload: ctx.trigger.payload,
    steps: stepsToSend,
    env: mergedEnv,
    // Pass the full execution metadata so scripts can use bidspoke_link,
    // execution_id, workflow_id alongside trace_id. ctx.execution is
    // populated by buildContext; if missing, fall back to {trace_id} only.
    execution: ctx.execution ?? { trace_id: ctx.trigger.trace_id },
    props: resolvedProps,
    shadow_mode: ctx.shadow_mode ?? 'off',
  })
}

/**
 * Attempts to dispatch to the bundled worker first; falls back to the legacy
 * per-node worker if the bundle is missing (503) or the namespace isn't in
 * the bundle (404). Any other status (including 500 from a user script error)
 * is returned directly — we do NOT fall back on script errors, since that
 * could silently run stale code.
 */
async function dispatchWithFallback(
  env: Env,
  workflowId: string,
  namespace: string,
  body: string,
  bundleNameOverride?: string,
  signal?: AbortSignal
): Promise<Response> {
  // Test runs pass an ephemeral content-hashed bundle name so unsaved edits run
  // immediately; prod runs use the stable per-workflow bundle.
  const bundleBinding = env.DYNAMIC_WORKER_LOADER.get(bundleNameOverride ?? codeBundleName(workflowId))
  let bundleRes: Response | undefined
  let bindingError: unknown
  try {
    bundleRes = await bundleBinding.fetch(`https://worker/execute/${namespace}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal,  // cancel the dispatch on the step-level timeout (#66)
    })
  } catch (err) {
    bindingError = err
  }

  // A transient binding throw (network blip, dispatch infra error) is NOT a
  // bundle-missing signal. Falling back to the legacy per-node worker here would
  // silently run stale orphaned code on a live lead (#475). Only a genuine
  // "Worker not found" throw means the bundle isn't deployed. Re-throw anything
  // else so the engine's retry/error classification handles it.
  if (bindingError !== undefined && !isWorkerNotFoundError(bindingError)) {
    throw bindingError instanceof Error ? bindingError : new Error(formatErr(bindingError))
  }

  const bundleMissing =
    bindingError !== undefined ||   // guaranteed a "Worker not found" throw at this point
    bundleRes?.status === 503 ||
    bundleRes?.status === 404

  if (!bundleMissing && bundleRes) return bundleRes

  // Test runs target a freshly-deployed ephemeral bundle. The legacy per-node
  // worker is stale-by-definition, so falling back to it would silently run old
  // code — exactly what the ephemeral bundle exists to prevent. Surface the miss
  // instead.
  if (bundleNameOverride) {
    throw new Error(`Test code bundle "${bundleNameOverride}" not reachable for "${namespace}" (status ${bundleRes?.status ?? 'binding error'})`)
  }

  console.log(`[code-node] Bundle miss for "${namespace}" on workflow ${workflowId.slice(0, 8)}, falling back to per-node worker`)
  const perNodeBinding = env.DYNAMIC_WORKER_LOADER.get(codeWorkerName(workflowId, namespace))
  return perNodeBinding.fetch('https://worker/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal,  // cancel the dispatch on the step-level timeout (#66)
  })
}
