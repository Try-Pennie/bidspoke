/**
 * Where a run's code nodes are dispatched (#1708 part B, plan 0.D).
 *
 * A live run and a canvas test run dispatch to the money namespace
 * (DYNAMIC_WORKER_LOADER) and make their real calls. A shadow run dispatches to
 * the compare namespace (COMPARE_CODE_LOADER), whose outbound Worker refuses
 * every request, and only to the bundle deployed there for it. It never falls
 * back to the money namespace's legacy per node workers, which would make the
 * very calls the compare namespace exists to stop.
 */
import { describe, it, expect, vi } from 'vitest'
import { codeDispatchTarget, CompareDispatchUnavailableError, executeCodeNode } from '../code'
import { executeCodeChain } from '../../index'
import { withRetry, type RetryStats } from '../../retry'
import { classifyStepError } from '../../error-classifier'
import { codeBundleName, codeWorkerName } from '../../../lib/code-node-deployer'
import type { Env } from '../../../index'
import type { ExecutionContext, NodeDefinition } from '../../../types'

const WF = 'da82a183-0000-4000-8000-000000000000'
const COMPARE_BUNDLE = 'bs-cmp-da82a183-0123abcd'

function ctx(o: { isTest?: boolean; shadow_mode?: 'off' | 'dry_run' | 'stand_in'; codeBundleName?: string } = {}): ExecutionContext {
  return { trigger: { payload: {}, source: 's', workflow_id: WF, trace_id: 't', org_id: 'o' }, steps: {}, env: {}, ...o }
}

/** A dispatch namespace that records every script it is asked for and answers each with `answer`. */
function namespace(answer: () => Response | Promise<Response>) {
  const asked: string[] = []
  const binding = {
    get: vi.fn((name: string) => {
      asked.push(name)
      return { fetch: vi.fn(() => Promise.resolve(answer())) }
    }),
  }
  return { asked, binding: binding as unknown as DispatchNamespace }
}

const ok = () => new Response(JSON.stringify({ __bsv: 1, output: { ok: true }, logs: [] }), { status: 200 })
const missing = () => new Response('not found', { status: 404 })
/** The platform's transient answer: the dispatch namespace is briefly unable to serve, not missing the bundle. */
const unavailable = () => new Response('Service Unavailable', { status: 503 })
/** Answers each call with the next of `answers`, repeating the last. */
const inTurn = (...answers: Array<() => Response>) => {
  let i = 0
  return () => answers[Math.min(i++, answers.length - 1)]()
}
/** A dispatch namespace whose scripts throw the platform's "Worker not found" error, the other way a missing bundle shows. */
function notFoundNamespace() {
  const asked: string[] = []
  const binding = {
    get: vi.fn((name: string) => {
      asked.push(name)
      return { fetch: vi.fn(() => Promise.reject(new Error(`Worker not found: ${name}`))) }
    }),
  }
  return { asked, binding: binding as unknown as DispatchNamespace }
}
const noSleep = () => Promise.resolve()
const env = (money: DispatchNamespace, compare?: DispatchNamespace) => ({ DYNAMIC_WORKER_LOADER: money, ...(compare ? { COMPARE_CODE_LOADER: compare } : {}) }) as unknown as Env
const node = (namespace: string): NodeDefinition => ({ id: namespace, namespace, type: 'code', config: { script: 'return 1' } })

describe('codeDispatchTarget', () => {
  it('sends a live run to the saved bundle in the money namespace, with the legacy fallback', () => {
    const money = namespace(ok)
    const t = codeDispatchTarget(env(money.binding), ctx(), { chain: false })
    expect(t).toMatchObject({ namespace: 'money', bundleName: codeBundleName(WF), legacyFallback: true })
    expect(t.binding).toBe(money.binding)
  })

  it("sends a canvas test run to its test bundle in the money namespace, with no fallback to stale code", () => {
    const money = namespace(ok)
    const t = codeDispatchTarget(env(money.binding), ctx({ isTest: true, codeBundleName: 'bs-wft-da82a183-aaaa0000' }), { chain: false })
    expect(t).toMatchObject({ namespace: 'money', bundleName: 'bs-wft-da82a183-aaaa0000', legacyFallback: false })
  })

  it('sends a shadow run to its compare bundle in the compare namespace, never with a fallback', () => {
    const money = namespace(ok)
    const compare = namespace(ok)
    for (const mode of ['dry_run', 'stand_in'] as const) {
      for (const chain of [false, true]) {
        const t = codeDispatchTarget(env(money.binding, compare.binding), ctx({ isTest: true, shadow_mode: mode, codeBundleName: COMPARE_BUNDLE }), { chain })
        expect(t).toMatchObject({ namespace: 'compare', bundleName: COMPARE_BUNDLE, legacyFallback: false })
        expect(t.binding).toBe(compare.binding)
      }
    }
  })

  it('refuses a shadow run by name when the compare namespace is not bound, rather than using the money one', () => {
    const money = namespace(ok)
    expect(() => codeDispatchTarget(env(money.binding), ctx({ isTest: true, shadow_mode: 'dry_run', codeBundleName: COMPARE_BUNDLE }), { chain: false }))
      .toThrow(CompareDispatchUnavailableError)
    expect(money.asked).toEqual([])
  })

  it('refuses a shadow run by name when no compare bundle was deployed for it', () => {
    const compare = namespace(ok)
    expect(() => codeDispatchTarget(env(namespace(ok).binding, compare.binding), ctx({ isTest: true, shadow_mode: 'dry_run' }), { chain: false }))
      .toThrow(/no compare bundle/)
  })
})

describe('a shadow run dispatches only to the compare namespace', () => {
  it('runs a single code node on the compare bundle and never asks the money namespace', async () => {
    const money = namespace(ok)
    const compare = namespace(ok)
    const result = await executeCodeNode(node('equifax_pull'), ctx({ isTest: true, shadow_mode: 'dry_run', codeBundleName: COMPARE_BUNDLE }), env(money.binding, compare.binding))
    expect(result.output).toEqual({ ok: true })
    expect(compare.asked).toEqual([COMPARE_BUNDLE])
    expect(money.asked).toEqual([])
  })

  it('fails a single code node whose compare bundle is missing, without falling back to a per node worker', async () => {
    const money = namespace(ok)
    const compare = namespace(missing)
    const err = await executeCodeNode(node('equifax_pull'), ctx({ isTest: true, shadow_mode: 'dry_run', codeBundleName: COMPARE_BUNDLE }), env(money.binding, compare.binding)).catch((e: unknown) => e)
    // The same permanent refusal the chain path records, so no retry repeats it.
    expect(err).toBeInstanceOf(CompareDispatchUnavailableError)
    expect((err as CompareDispatchUnavailableError).permanent).toBe(true)
    expect((err as Error).message).toMatch(/compare bundle/)
    expect(compare.asked).toEqual([COMPARE_BUNDLE])
    expect(money.asked).toEqual([])
  })

  it('runs a chain on the compare bundle, and on a missing bundle fails it rather than re-running it on per node workers', async () => {
    const chainOk = () => new Response(JSON.stringify({ results: [{ namespace: 'a', status: 'completed', output: {} }, { namespace: 'b', status: 'completed', output: {} }] }), { status: 200 })
    const money = namespace(ok)
    const compare = namespace(chainOk)
    const shadow = ctx({ isTest: true, shadow_mode: 'dry_run', codeBundleName: COMPARE_BUNDLE })
    await executeCodeChain([node('a'), node('b')], shadow, env(money.binding, compare.binding))
    expect(compare.asked).toEqual([COMPARE_BUNDLE])
    expect(money.asked).toEqual([])

    const gone = namespace(missing)
    const failed = await executeCodeChain([node('a'), node('b')], shadow, env(money.binding, gone.binding))
    expect(failed.results[0].status).toBe('failed')
    expect(failed.results[0].error).toMatch(/compare bundle/)
    expect(gone.asked).toEqual([COMPARE_BUNDLE])
    expect(money.asked).not.toContain(codeWorkerName(WF, 'a'))
    expect(money.asked).toEqual([])
  })

  it('marks a chain the compare namespace refused as permanently failed, unbound or with its bundle missing', async () => {
    const shadow = ctx({ isTest: true, shadow_mode: 'dry_run', codeBundleName: COMPARE_BUNDLE })
    const unbound = await executeCodeChain([node('a'), node('b')], shadow, env(namespace(ok).binding))
    expect(unbound.results[0]).toMatchObject({ status: 'failed', permanent: true })
    expect(unbound.results[0].error).toMatch(/compare namespace is not bound/)

    const gone = await executeCodeChain([node('a'), node('b')], shadow, env(namespace(ok).binding, namespace(missing).binding))
    expect(gone.results[0]).toMatchObject({ status: 'failed', permanent: true })
  })

  it('leaves a live chain on the saved bundle in the money namespace', async () => {
    const chainOk = () => new Response(JSON.stringify({ results: [{ namespace: 'a', status: 'completed', output: {} }] }), { status: 200 })
    const money = namespace(chainOk)
    const compare = namespace(chainOk)
    await executeCodeChain([node('a'), node('b')], ctx(), env(money.binding, compare.binding))
    expect(money.asked).toEqual([codeBundleName(WF)])
    expect(compare.asked).toEqual([])
  })
})

/**
 * A compare bundle answering 503 is the platform being briefly unable to serve,
 * not the bundle being missing (#1798). Only a 404 or a "Worker not found" throw
 * means the bundle is gone for good, so only those refuse permanently; a 503
 * takes the ordinary transient classification and the step is retried.
 */
describe('a compare namespace 503 is transient, a missing compare bundle is permanent (#1798)', () => {
  const shadow = () => ctx({ isTest: true, shadow_mode: 'dry_run', codeBundleName: COMPARE_BUNDLE })

  it('retries a single code node whose compare bundle answered 503, and succeeds on the next attempt', async () => {
    const money = namespace(ok)
    const compare = namespace(inTurn(unavailable, ok))
    const stats: RetryStats = { retries: 0 }
    const result = await withRetry(
      () => executeCodeNode(node('equifax_pull'), shadow(), env(money.binding, compare.binding)),
      { retries: 2, backoff: 'linear', timeout_ms: 5000 },
      classifyStepError,
      stats,
      noSleep,
    )
    expect(result.output).toEqual({ ok: true })
    expect(stats.retries).toBe(1)
    expect(compare.asked).toEqual([COMPARE_BUNDLE, COMPARE_BUNDLE])
    expect(money.asked).toEqual([])
  })

  it('classifies a compare 503 as transient and names the compare bundle, without falling back to the money namespace', async () => {
    const money = namespace(ok)
    const compare = namespace(unavailable)
    const err = await executeCodeNode(node('equifax_pull'), shadow(), env(money.binding, compare.binding)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(CompareDispatchUnavailableError)
    expect(classifyStepError(err)).toBe('transient')
    expect((err as Error).message).toMatch(/compare bundle/)
    expect((err as Error).message).toMatch(/503/)
    expect(money.asked).toEqual([])
  })

  it('still refuses a single code node permanently on a 404 or a "Worker not found" throw from the compare namespace', async () => {
    for (const compare of [namespace(missing), notFoundNamespace()]) {
      const money = namespace(ok)
      const err = await executeCodeNode(node('equifax_pull'), shadow(), env(money.binding, compare.binding)).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(CompareDispatchUnavailableError)
      expect(classifyStepError(err)).toBe('permanent')
      expect(money.asked).toEqual([])
    }
  })

  it('fails a chain whose compare bundle answered 503 as transient, not permanent, and never on per node workers', async () => {
    const money = namespace(ok)
    const failed = await executeCodeChain([node('a'), node('b')], shadow(), env(money.binding, namespace(unavailable).binding))
    expect(failed.results).toHaveLength(1)
    expect(failed.results[0].status).toBe('failed')
    expect(failed.results[0].permanent).toBeUndefined()
    expect(failed.results[0].error).toMatch(/compare bundle/)
    expect(failed.results[0].error).toMatch(/503/)
    expect(money.asked).toEqual([])
  })

  it('still fails a chain permanently on a 404 or a "Worker not found" throw from the compare namespace', async () => {
    for (const compare of [namespace(missing), notFoundNamespace()]) {
      const money = namespace(ok)
      const failed = await executeCodeChain([node('a'), node('b')], shadow(), env(money.binding, compare.binding))
      expect(failed.results[0]).toMatchObject({ status: 'failed', permanent: true })
      expect(failed.results[0].error).toMatch(/compare bundle/)
      expect(money.asked).toEqual([])
    }
  })
})

/** The money namespace reads a 503 as a missing bundle, as before #1798, and that must not move. */
describe('the money namespace still reads a bundle 503 as a missing bundle', () => {
  it('falls back to the legacy per node worker when a live run\'s saved bundle answers 503', async () => {
    const money = namespace(inTurn(unavailable, ok))
    const result = await executeCodeNode(node('equifax_pull'), ctx(), env(money.binding, namespace(ok).binding))
    expect(result.output).toEqual({ ok: true })
    expect(money.asked).toEqual([codeBundleName(WF), codeWorkerName(WF, 'equifax_pull')])
  })

  it('fails a canvas test run whose test bundle answers 503 with the plain test bundle message, not a compare refusal', async () => {
    const money = namespace(unavailable)
    const err = await executeCodeNode(node('equifax_pull'), ctx({ isTest: true, codeBundleName: 'bs-wft-da82a183-aaaa0000' }), env(money.binding)).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(CompareDispatchUnavailableError)
    expect((err as Error).message).toMatch(/Test code bundle "bs-wft-da82a183-aaaa0000" not reachable for "equifax_pull" \(status 503\)/)
    expect(money.asked).toEqual(['bs-wft-da82a183-aaaa0000'])
  })

  it('re-runs a live chain on per node workers when the saved bundle answers 503', async () => {
    const money = namespace(inTurn(unavailable, ok))
    const result = await executeCodeChain([node('a'), node('b')], ctx(), env(money.binding, namespace(ok).binding))
    expect(result.results.map((r) => r.status)).toEqual(['completed', 'completed'])
    expect(money.asked).toEqual([codeBundleName(WF), codeWorkerName(WF, 'a'), codeWorkerName(WF, 'b')])
  })
})
