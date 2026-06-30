import { describe, it, expect, vi } from 'vitest'
import { executeCodeNode, unionReferencedSteps, scopeSteps, hasDynamicStepsAccess } from '../code'
import { codeWorkerName, codeBundleName, buildBundledWorkerScript } from '../../../lib/code-node-deployer'
import type { ExecutionContext, NodeDefinition, StepOutput } from '../../../types'
import type { Env } from '../../../index'

describe('hasDynamicStepsAccess', () => {
  it('is false for plain dot references', () => {
    expect(hasDynamicStepsAccess('const x = steps.foo.output.a')).toBe(false)
  })
  it('is true for bracket access', () => {
    expect(hasDynamicStepsAccess('steps["foo"]')).toBe(true)
  })
  it('is true for whole-object aliasing', () => {
    expect(hasDynamicStepsAccess('const all = steps')).toBe(true)
  })
  it('is true for Object.keys(steps)', () => {
    expect(hasDynamicStepsAccess('Object.keys(steps)')).toBe(true)
  })
  it('is true for for-in over steps', () => {
    expect(hasDynamicStepsAccess('for (const k in steps) {}')).toBe(true)
  })
})

// #190: the chain code-node path used to send the full step context to every
// chained node. These two pure helpers let it scope to the union of what the
// chain's scripts reference — mirroring the single-node path.
describe('unionReferencedSteps (#190)', () => {
  it('unions the referenced namespaces across all chain scripts', () => {
    const refs = unionReferencedSteps([
      'return steps.alpha.output.v',
      'return steps.beta.output.v + steps.alpha.output.v',
    ])
    expect(refs).not.toBeNull()
    expect([...refs!].sort()).toEqual(['alpha', 'beta'])
  })

  it('returns null (send-all) when ANY script uses a dynamic access pattern', () => {
    expect(unionReferencedSteps(['return steps.alpha.v', 'return Object.keys(steps)'])).toBeNull()
    expect(unionReferencedSteps(['const k = "a"; return steps[k]'])).toBeNull()
  })

  it('returns an empty set when no script references any step', () => {
    const refs = unionReferencedSteps(['return payload.id', 'return 1 + 1'])
    expect(refs).not.toBeNull()
    expect(refs!.size).toBe(0)
  })
})

describe('scopeSteps (#190)', () => {
  const steps: Record<string, StepOutput> = {
    a: { output: { v: 1 }, status: 'completed' },
    b: { output: { v: 2 }, status: 'completed' },
  }

  it('sends every step plus trigger when referenced is null (dynamic access)', () => {
    const out = scopeSteps(steps, { id: 'L1' }, null)
    expect(Object.keys(out).sort()).toEqual(['a', 'b', 'trigger'])
    expect(out.trigger).toEqual({ payload: { id: 'L1' } })
  })

  it('sends only the referenced steps plus trigger', () => {
    const out = scopeSteps(steps, { id: 'L1' }, new Set(['a']))
    expect(Object.keys(out).sort()).toEqual(['a', 'trigger'])
    expect(out.b).toBeUndefined()
  })

  it('ignores a referenced namespace that does not exist and never duplicates trigger', () => {
    const out = scopeSteps(steps, { id: 'L1' }, new Set(['trigger', 'missing']))
    expect(Object.keys(out).sort()).toEqual(['trigger'])
  })
})

function ctx(): ExecutionContext {
  return {
    trigger: { payload: { lead_id: 'lead-1' }, source: 'test', workflow_id: 'wf-abc123', org_id: '', trace_id: 'trace' },
    steps: { prev: { output: { score: 720 }, status: 'completed' } },
    env: { API_KEY: 'secret' },
  }
}

function node(config: NodeDefinition['config']): NodeDefinition {
  return { id: 'n1', namespace: 'code_step', type: 'code', config }
}

/**
 * Builds an Env whose DYNAMIC_WORKER_LOADER routes `get(name)` to a dedicated
 * mock fetch — lets tests assert which worker name was dispatched to, and
 * simulate bundle-missing scenarios by returning a 503 from the bundle binding.
 */
function makeEnv(getRouter: (name: string) => ReturnType<typeof vi.fn>): Env {
  return {
    DYNAMIC_WORKER_LOADER: {
      get: vi.fn((name: string) => ({ fetch: getRouter(name) })),
    } as unknown as DispatchNamespace,
  } as unknown as Env
}

describe('executeCodeNode', () => {
  it('throws if script is not configured', async () => {
    const env = makeEnv(() => vi.fn())
    await expect(executeCodeNode(node({}), ctx(), env)).rejects.toThrow(/no script configured/)
  })

  it('throws if script is empty string', async () => {
    const env = makeEnv(() => vi.fn())
    await expect(executeCodeNode(node({ script: '   ' }), ctx(), env)).rejects.toThrow(/no script configured/)
  })

  it('dispatches to the bundled worker with /execute/{namespace} path', async () => {
    const bundleFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const env = makeEnv((name) => (name === codeBundleName('wf-abc123') ? bundleFetch : vi.fn()))
    await executeCodeNode(node({ script: 'return {}' }), ctx(), env)
    expect(bundleFetch).toHaveBeenCalledTimes(1)
    const url = bundleFetch.mock.calls[0][0] as string
    expect(url).toBe('https://worker/execute/code_step')
  })

  // #66: a step-level timeout must cancel the dispatch to the code worker.
  it('passes the step-level abort signal to the dispatch fetch (#66)', async () => {
    const bundleFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const env = makeEnv(() => bundleFetch)
    const parent = new AbortController()
    parent.abort()
    await executeCodeNode(node({ script: 'return {}' }), ctx(), env, parent.signal)
    const init = bundleFetch.mock.calls[0][1] as RequestInit
    expect((init.signal as AbortSignal | undefined)?.aborted).toBe(true)
  })

  it('sends payload, steps, env, and execution to the worker', async () => {
    const bundleFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const env = makeEnv(() => bundleFetch)
    const c = ctx()
    await executeCodeNode(node({ script: 'return {}' }), c, env)
    const body = JSON.parse(bundleFetch.mock.calls[0][1].body as string) as unknown
    expect(body).toMatchObject({ payload: c.trigger.payload, env: c.env, execution: { trace_id: 'trace' } })
  })

  it('returns the JSON output from the worker', async () => {
    const output = { credit_score: 720, approved: true }
    const env = makeEnv(() => vi.fn().mockResolvedValue(new Response(JSON.stringify(output), { status: 200 })))
    const result = await executeCodeNode(node({ script: 'return {}' }), ctx(), env)
    expect(result.output).toEqual(output)
  })

  it('surfaces the raw response text when non-OK and body is not JSON', async () => {
    const env = makeEnv(() => vi.fn().mockResolvedValue(new Response('ReferenceError: x is not defined', { status: 500 })))
    await expect(executeCodeNode(node({ script: 'return {}' }), ctx(), env)).rejects.toThrow('ReferenceError: x is not defined')
  })

  it('extracts { error } from a JSON 500 body so the real script error reaches the user', async () => {
    const env = makeEnv(() => vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Gmail API error 403: quota exceeded' }), { status: 500 })))
    await expect(executeCodeNode(node({ script: 'return {}' }), ctx(), env)).rejects.toThrow('Gmail API error 403: quota exceeded')
  })

  // #458: the sandbox now reports the thrown error's constructor name in the
  // envelope. The executor attaches it as codeErrorName so the classifier can
  // fail deterministic programming errors fast instead of retrying them.
  it('attaches the sandbox error name (codeErrorName) from the 500 envelope', async () => {
    const envelope = { __bsv: 1, error: "Cannot read properties of undefined (reading 'output')", name: 'TypeError' }
    const env = makeEnv(() => vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope), { status: 500 })))
    const err = await executeCodeNode(node({ script: 'return {}' }), ctx(), env).catch((e: unknown) => e)
    expect((err as { codeErrorName?: string }).codeErrorName).toBe('TypeError')
  })

  it('leaves codeErrorName unset when the envelope carries no name (older bundle)', async () => {
    const envelope = { __bsv: 1, error: 'boom' }
    const env = makeEnv(() => vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope), { status: 500 })))
    const err = await executeCodeNode(node({ script: 'return {}' }), ctx(), env).catch((e: unknown) => e)
    expect((err as { codeErrorName?: string }).codeErrorName).toBeUndefined()
  })

  it('returns earlyResponse when script returns { response: { status, body } }', async () => {
    const sentinel = { response: { status: 200, body: { status: 'rejected', reason: 'ineligible state' } } }
    const env = makeEnv(() => vi.fn().mockResolvedValue(new Response(JSON.stringify(sentinel), { status: 200 })))
    const result = await executeCodeNode(node({ script: 'return {}' }), ctx(), env)
    expect(result.earlyResponse).toEqual({ status: 200, body: { status: 'rejected', reason: 'ineligible state' }, headers: undefined })
  })

  it('returns earlyExit when script returns { exit: true }', async () => {
    const sentinel = { exit: true, reason: 'bidding not active' }
    const env = makeEnv(() => vi.fn().mockResolvedValue(new Response(JSON.stringify(sentinel), { status: 200 })))
    const result = await executeCodeNode(node({ script: 'return {}' }), ctx(), env)
    expect(result.earlyExit).toBe(true)
  })

  it('does not set earlyResponse for objects with a response field that is not an object', async () => {
    const output = { response: 'some string value', other: 123 }
    const env = makeEnv(() => vi.fn().mockResolvedValue(new Response(JSON.stringify(output), { status: 200 })))
    const result = await executeCodeNode(node({ script: 'return {}' }), ctx(), env)
    expect(result.earlyResponse).toBeUndefined()
    expect(result.output).toEqual(output)
  })
})

describe('executeCodeNode — steps filtering by static analysis', () => {
  function ctxWithSteps(): ExecutionContext {
    return {
      trigger: { payload: { id: 'L1' }, source: 'test', workflow_id: 'wf', org_id: '', trace_id: 'trace' },
      steps: {
        small_a:  { output: { v: 1 }, status: 'completed' },
        small_b:  { output: { v: 2 }, status: 'completed' },
        huge_c:   { output: { blob: 'x'.repeat(50_000) }, status: 'completed' },
        unused_d: { output: { nope: true }, status: 'completed' },
      },
      env: {},
    }
  }

  it('sends only the referenced steps when the script uses dot access', async () => {
    const bundleFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const env = makeEnv(() => bundleFetch)
    await executeCodeNode(
      node({ script: 'return steps.small_a.output.v + steps.small_b.output.v' }),
      ctxWithSteps(),
      env
    )
    const sent = JSON.parse(bundleFetch.mock.calls[0][1].body as string) as { steps: Record<string, unknown> }
    expect(Object.keys(sent.steps).sort()).toEqual(['small_a', 'small_b', 'trigger'])
    expect(sent.steps.huge_c).toBeUndefined()
    expect(sent.steps.unused_d).toBeUndefined()
  })

  it('falls back to sending all steps when script uses bracket access', async () => {
    const bundleFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const env = makeEnv(() => bundleFetch)
    await executeCodeNode(
      node({ script: 'const key = "small_a"; return steps[key].output.v' }),
      ctxWithSteps(),
      env
    )
    const sent = JSON.parse(bundleFetch.mock.calls[0][1].body as string) as { steps: Record<string, unknown> }
    expect(Object.keys(sent.steps).sort()).toEqual(['huge_c', 'small_a', 'small_b', 'trigger', 'unused_d'])
  })

  it('falls back to sending all steps when script aliases the steps object', async () => {
    const bundleFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const env = makeEnv(() => bundleFetch)
    await executeCodeNode(
      node({ script: 'const s = steps; return s.small_a.output.v' }),
      ctxWithSteps(),
      env
    )
    const sent = JSON.parse(bundleFetch.mock.calls[0][1].body as string) as { steps: Record<string, unknown> }
    expect(sent.steps.huge_c).toBeDefined()
  })

  it('falls back when script uses Object.keys(steps)', async () => {
    const bundleFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const env = makeEnv(() => bundleFetch)
    await executeCodeNode(
      node({ script: 'return Object.keys(steps).length' }),
      ctxWithSteps(),
      env
    )
    const sent = JSON.parse(bundleFetch.mock.calls[0][1].body as string) as { steps: Record<string, unknown> }
    expect(sent.steps.huge_c).toBeDefined()
  })

  it('always includes trigger in the steps payload', async () => {
    const bundleFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const env = makeEnv(() => bundleFetch)
    await executeCodeNode(
      node({ script: 'return payload.id' }),  // no steps references
      ctxWithSteps(),
      env
    )
    const sent = JSON.parse(bundleFetch.mock.calls[0][1].body as string) as { steps: Record<string, unknown> }
    expect(sent.steps.trigger).toEqual({ payload: { id: 'L1' } })
    // No non-trigger steps should be included
    expect(Object.keys(sent.steps)).toEqual(['trigger'])
  })
})

describe('executeCodeNode — bundle fallback to per-node worker', () => {
  it('falls back to the per-node worker when the bundle returns 503 (worker not deployed)', async () => {
    const bundleFetch = vi.fn().mockResolvedValue(new Response('Worker not found', { status: 503 }))
    const perNodeFetch = vi.fn().mockResolvedValue(new Response('{"result":"from-legacy"}', { status: 200 }))
    const bundleName = codeBundleName('wf-abc123')
    const perNodeName = codeWorkerName('wf-abc123', 'code_step')
    const env = makeEnv((name) => {
      if (name === bundleName) return bundleFetch
      if (name === perNodeName) return perNodeFetch
      return vi.fn()
    })
    const result = await executeCodeNode(node({ script: 'return {}' }), ctx(), env)
    expect(bundleFetch).toHaveBeenCalledTimes(1)
    expect(perNodeFetch).toHaveBeenCalledTimes(1)
    expect(perNodeFetch.mock.calls[0][0]).toBe('https://worker/execute')
    expect(result.output).toEqual({ result: 'from-legacy' })
  })

  it('falls back when the bundle returns 404 (namespace not in bundle)', async () => {
    const bundleFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'script not found: code_step' }), { status: 404 }))
    const perNodeFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    const env = makeEnv((name) => (name === codeBundleName('wf-abc123') ? bundleFetch : perNodeFetch))
    const result = await executeCodeNode(node({ script: 'return {}' }), ctx(), env)
    expect(perNodeFetch).toHaveBeenCalledTimes(1)
    expect(result.output).toEqual({ ok: true })
  })

  it('does NOT fall back on a 500 script error from the bundle (surfaces the error)', async () => {
    const bundleFetch = vi.fn().mockResolvedValue(new Response('TypeError: x.y is undefined', { status: 500 }))
    const perNodeFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    const env = makeEnv((name) => (name === codeBundleName('wf-abc123') ? bundleFetch : perNodeFetch))
    await expect(executeCodeNode(node({ script: 'return {}' }), ctx(), env)).rejects.toThrow('TypeError: x.y is undefined')
    expect(perNodeFetch).not.toHaveBeenCalled()
  })

  it('falls back when the binding itself throws', async () => {
    const bundleFetch = vi.fn().mockRejectedValue(new Error('binding resolve failed'))
    const perNodeFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    const env = makeEnv((name) => (name === codeBundleName('wf-abc123') ? bundleFetch : perNodeFetch))
    const result = await executeCodeNode(node({ script: 'return {}' }), ctx(), env)
    expect(result.output).toEqual({ ok: true })
  })
})

describe('codeWorkerName', () => {
  it('produces a deterministic name from workflow id and namespace', () => {
    expect(codeWorkerName('abc12345-xxxx', 'validate')).toBe('bs-abc12345-validate')
  })

  it('truncates to 64 chars', () => {
    const name = codeWorkerName('a'.repeat(36), 'n'.repeat(40))
    expect(name.length).toBeLessThanOrEqual(64)
  })
})

describe('codeBundleName', () => {
  it('produces a deterministic bundle name from workflow id', () => {
    expect(codeBundleName('abc12345-xxxx-yyyy')).toBe('bs-wf-abc12345')
  })

  it('is distinct from the per-node legacy name', () => {
    const wfId = 'abc12345-xxxx'
    expect(codeBundleName(wfId)).not.toBe(codeWorkerName(wfId, 'validate'))
  })
})

describe('buildBundledWorkerScript', () => {
  it('wraps each script into a named entry in the scripts map', () => {
    const bundle = buildBundledWorkerScript([
      { namespace: 'parse_name', script: 'return { firstName: payload.name }' },
      { namespace: 'validate', script: 'return { ok: true }' },
    ])
    expect(bundle).toContain('"parse_name":')
    expect(bundle).toContain('"validate":')
    expect(bundle).toContain('return { firstName: payload.name }')
    expect(bundle).toContain('return { ok: true }')
  })

  it('exports a fetch handler with /execute/{namespace} routing', () => {
    const bundle = buildBundledWorkerScript([{ namespace: 'foo', script: 'return 1' }])
    expect(bundle).toContain('export default {')
    expect(bundle).toContain('async fetch(request)')
    // Regex literal is emitted with escaped slashes: /^\/execute\/([^/]+)$/
    expect(bundle).toContain('\\/execute\\/([^/]+)')
  })

  it('provides trigger and process locals to each script closure', () => {
    const bundle = buildBundledWorkerScript([{ namespace: 'x', script: 'return trigger.payload' }])
    expect(bundle).toContain('const trigger = { payload }')
    expect(bundle).toContain('const process = { env }')
  })

  // #458: both the single-execute and chain catch blocks must surface the thrown
  // error's constructor name so the engine can classify deterministic
  // programming errors as permanent (no retry).
  it('surfaces the thrown error name in both the single-execute and chain catch blocks', () => {
    const bundle = buildBundledWorkerScript([{ namespace: 'x', script: 'return 1' }])
    // Null-safe extraction (a script can `throw null`): never dereference
    // .constructor on a falsy throw value.
    const nameOccurrences = bundle.split("err && err.name ? err.name : (err ? err.constructor.name : 'Error')").length - 1
    expect(nameOccurrences).toBeGreaterThanOrEqual(2)
  })
})
