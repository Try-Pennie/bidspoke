// Code node — user-defined JS executed in a sandboxed Dynamic Worker.
// On workflow save, all code scripts are deployed into a single bundled worker
// per workflow (one dispatch worker, path-routed by namespace). This executor
// dispatches to /execute/{namespace} on that bundle. If the bundle is missing
// or doesn't contain this namespace (migration in progress), it falls back to
// the legacy per-node worker.

import type { NodeDefinition, ExecutionContext, StepExecutionResult, StepOutput, ResolvedStepInput } from '../../types'
import type { Env } from '../../index'
import { codeBundleName, codeWorkerName } from '../../lib/code-node-deployer'
import { sandboxEnvBindings } from '../../lib/sandbox-env'
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
  if (/\bsteps\s*\[/.test(script)) return null
  if (/\b(?:const|let|var)\s+\w+\s*=\s*steps\b(?!\.)/.test(script)) return null
  if (/\bObject\s*\.\s*(?:keys|entries|values|assign)\s*\(\s*steps\b/.test(script)) return null
  if (/\bfor\s*\(\s*(?:const|let|var)\s+\w+\s+(?:in|of)\s+steps\b/.test(script)) return null
  const refs = new Set<string>()
  const re = /\bsteps\s*\.\s*([a-zA-Z_$][\w$]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(script)) !== null) {
    refs.add(m[1])
  }
  return refs
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
  // vars still flow (#108).
  const mergedEnv = { ...sandboxEnvBindings(env), ...ctx.env }

  // Filter the steps payload to only what this script actually references.
  // For workflows like engine bidding where Equifax/trade responses are 20-80KB
  // each, skipping unused steps cuts subrequest payload size by 60-80% and
  // shaves measurable time off JSON stringify + network + parse on the worker.
  const referenced = extractReferencedSteps(script)
  let stepsToSend: Record<string, StepOutput | { payload: unknown }>
  if (referenced === null) {
    // Unsafe access pattern detected — send everything.
    stepsToSend = { ...ctx.steps, trigger: { payload: ctx.trigger.payload } }
  } else {
    const filtered: Record<string, StepOutput> = {}
    for (const ns of referenced) {
      if (ns === 'trigger') continue
      const entry = ctx.steps[ns]
      if (entry) filtered[ns] = entry
    }
    stepsToSend = { ...filtered, trigger: { payload: ctx.trigger.payload } }
  }

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

  // Parse the response, then unwrap the {__bsv: 1, output, logs} envelope if
  // present. Older bundles deployed before envelope support return bare output;
  // the envelope flag lets us tell them apart unambiguously without any
  // collision risk against user-returned objects shaped like {output, logs}.
  let parsed: unknown = null
  if (text !== '' && text !== 'undefined') {
    try { parsed = JSON.parse(text) } catch { parsed = text }
  }
  const envelope = isEnvelope(parsed) ? parsed : null

  if (!res.ok) {
    const detail = envelope
      ? (envelope.error ?? text)
      : extractLegacyError(text)
    const err = new Error(detail) as Error & {
      logs?: import('../../types').StepLogEntry[]
      resolvedInput?: ResolvedStepInput
    }
    if (envelope && Array.isArray(envelope.logs)) err.logs = envelope.logs as import('../../types').StepLogEntry[]
    err.resolvedInput = resolvedInput
    throw err
  }

  const output: unknown = envelope ? (envelope.output ?? null) : parsed
  const logs = envelope && Array.isArray(envelope.logs)
    ? (envelope.logs as import('../../types').StepLogEntry[])
    : undefined

  // Detect early-exit sentinels emitted by translated Pipedream code:
  //   $.respond({...})  → return { response: { status, body, headers? } }
  //   $.flow.exit(...)  → return { exit: true, reason: ... }
  if (output !== null && typeof output === 'object') {
    const obj = output as Record<string, unknown>
    if ('response' in obj && obj.response !== null && typeof obj.response === 'object') {
      const r = obj.response as { status?: number; body?: unknown; headers?: Record<string, string> }
      const expected = obj.expected === true ? (true as const) : undefined
      if (obj.continueExecution === true) {
        return { output, earlyResponse: { status: r.status ?? 200, body: r.body ?? null, headers: r.headers }, continueAfterResponse: true, expected, logs, resolvedInput }
      }
      return { output, earlyResponse: { status: r.status ?? 200, body: r.body ?? null, headers: r.headers }, expected, logs, resolvedInput }
    }
    if (obj.exit === true) {
      return { output, earlyExit: true, logs, resolvedInput }
    }
  }

  return { output, logs, resolvedInput }
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

function isEnvelope(v: unknown): v is { __bsv: 1; output?: unknown; logs?: unknown; error?: string } {
  return v !== null && typeof v === 'object' && (v as { __bsv?: unknown }).__bsv === 1
}

function extractLegacyError(text: string): string {
  try {
    const p = JSON.parse(text) as { error?: string }
    if (p?.error) return p.error
  } catch { /* keep raw text */ }
  return text
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

  const bundleMissing =
    bindingError !== undefined ||
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
