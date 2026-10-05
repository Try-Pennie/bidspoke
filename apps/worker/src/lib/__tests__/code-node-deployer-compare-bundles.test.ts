/**
 * The compare bundle a shadow run's code runs on (#1708 part B, plan 0.D).
 *
 * Deployed lazily, by the shadow route, keyed by the bundle's content hash, into
 * the compare namespace, whose outbound Worker refuses every request. Never on
 * the save path and never into the money namespace.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { compareBundleName, deployCompareCodeBundle, COMPARE_NAMESPACE, CODE_NAMESPACE } from '../code-node-deployer'
import type { WorkflowDefinition } from '../../types'

const WF = 'abcdef12-3456-7890-abcd-ef1234567890'
const ACCT = 'acct'
const TOKEN = 'tok'

function makeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  } as unknown as KVNamespace & { store: Map<string, string> }
}

const defWithCode = (script: string): WorkflowDefinition =>
  ({ nodes: [{ id: 'n1', type: 'code', namespace: 'equifax_pull', config: { script } }], edges: [], trigger: { type: 'http_webhook', config: {} } }) as unknown as WorkflowDefinition

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
})
afterEach(() => vi.unstubAllGlobals())

describe('compareBundleName', () => {
  it('is content versioned, its own prefix, and bounded to 64 characters', () => {
    const a = compareBundleName(WF, 'aaaaaaaa1111')
    expect(a).toBe('bs-cmp-abcdef12-aaaaaaaa')
    expect(compareBundleName(WF, 'bbbbbbbb2222')).not.toBe(a)
    expect(a.length).toBeLessThanOrEqual(64)
  })
})

describe('deployCompareCodeBundle', () => {
  it('uploads to the compare namespace only, under the hashed name it returns', async () => {
    const { bundleName, error } = await deployCompareCodeBundle(WF, defWithCode('return 1'), ACCT, TOKEN, makeKv())
    expect(error).toBeUndefined()
    expect(bundleName).toMatch(/^bs-cmp-abcdef12-[0-9a-f]{8}$/)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/workers/dispatch/namespaces/${COMPARE_NAMESPACE}/scripts/${bundleName}`)
    expect(url).not.toContain(`/namespaces/${CODE_NAMESPACE}/`)
    expect(init.method).toBe('PUT')
  })

  it('names two namespaces that differ, so the compare bundle can never land in the money one', () => {
    expect(COMPARE_NAMESPACE).toBe('bidspoke-code-nodes-compare')
    expect(CODE_NAMESPACE).toBe('bidspoke-code-nodes')
  })

  it('uploads the same code once, answering later shadow runs from the record of it', async () => {
    const kv = makeKv()
    const first = await deployCompareCodeBundle(WF, defWithCode('return 1'), ACCT, TOKEN, kv)
    const second = await deployCompareCodeBundle(WF, defWithCode('return 1'), ACCT, TOKEN, kv)
    expect(second.bundleName).toBe(first.bundleName)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('uploads changed code under a new name', async () => {
    const kv = makeKv()
    const a = await deployCompareCodeBundle(WF, defWithCode('return 1'), ACCT, TOKEN, kv)
    const b = await deployCompareCodeBundle(WF, defWithCode('return 2'), ACCT, TOKEN, kv)
    expect(a.bundleName).not.toBe(b.bundleName)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('deploys nothing for a workflow with no code', async () => {
    const def = { nodes: [{ id: 'n1', type: 'filter', namespace: 'f', config: {} }], edges: [], trigger: { type: 'http_webhook', config: {} } } as unknown as WorkflowDefinition
    expect(await deployCompareCodeBundle(WF, def, ACCT, TOKEN, makeKv())).toEqual({ bundleName: null })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails by name when the upload is refused, and records nothing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: 'namespace not found' }] }), { status: 404 }))
    const kv = makeKv()
    const result = await deployCompareCodeBundle(WF, defWithCode('return 1'), ACCT, TOKEN, kv)
    expect(result).toEqual({ bundleName: null, error: 'namespace not found' })
    expect(kv.store.size).toBe(0)
  })

  it('fails by name when Cloudflare is not configured, rather than reporting nothing to deploy', async () => {
    const result = await deployCompareCodeBundle(WF, defWithCode('return 1'), undefined, TOKEN, makeKv())
    expect(result.bundleName).toBeNull()
    expect(result.error).toMatch(/not configured/)
    expect(fetch).not.toHaveBeenCalled()
  })
})
