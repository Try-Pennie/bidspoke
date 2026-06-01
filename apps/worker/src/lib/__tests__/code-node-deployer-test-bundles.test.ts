/**
 * Ephemeral test-bundle deploy/cleanup — the content-hashed bundle that lets the
 * test runner execute unsaved code-node edits without dispatch-namespace stale reads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { testBundleName, deployTestCodeBundle, deleteTestBundles } from '../code-node-deployer'
import type { WorkflowDefinition } from '../../types'

const WF = 'abcdef12-3456-7890-abcd-ef1234567890'
const ACCT = 'acct'
const TOKEN = 'tok'

function makeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string, _t?: string) => {
      const v = store.get(k)
      if (v === undefined) return null
      return _t === 'json' ? JSON.parse(v) : v
    }),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  } as unknown as KVNamespace & { store: Map<string, string> }
}

function defWithCode(script: string): WorkflowDefinition {
  return {
    nodes: [{ id: 'n1', type: 'code', namespace: 'build_response', config: { script } }],
    edges: [],
    trigger: { type: 'http_webhook', config: {} },
  } as unknown as WorkflowDefinition
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
})
afterEach(() => vi.unstubAllGlobals())

describe('testBundleName', () => {
  it('is content-versioned (different hash → different name) and bounded to 64 chars', () => {
    const a = testBundleName(WF, 'aaaaaaaa1111')
    const b = testBundleName(WF, 'bbbbbbbb2222')
    expect(a).not.toBe(b)
    expect(a.startsWith('bs-wft-abcdef12-')).toBe(true)
    expect(a.length).toBeLessThanOrEqual(64)
  })
})

describe('deployTestCodeBundle', () => {
  it('deploys to a hashed name, returns it, and tracks it for cleanup', async () => {
    const kv = makeKv()
    const { bundleName } = await deployTestCodeBundle(WF, defWithCode('return { body: 1 }'), ACCT, TOKEN, kv)
    expect(bundleName).toMatch(/^bs-wft-abcdef12-[0-9a-f]{8}$/)
    expect(fetch).toHaveBeenCalledTimes(1)
    // Tracked in the per-workflow list for later deleteTestBundles
    const tracked = JSON.parse(kv.store.get(`test-bundles-${WF}`) as string)
    expect(tracked).toContain(bundleName)
  })

  it('skips the upload when the same content was already deployed', async () => {
    const kv = makeKv()
    const def = defWithCode('return { body: 2 }')
    const first = await deployTestCodeBundle(WF, def, ACCT, TOKEN, kv)
    const second = await deployTestCodeBundle(WF, def, ACCT, TOKEN, kv)
    expect(second.bundleName).toBe(first.bundleName)
    expect(fetch).toHaveBeenCalledTimes(1) // second call hits the skip cache
  })

  it('edited script produces a different bundle name (no stale reuse)', async () => {
    const kv = makeKv()
    const a = await deployTestCodeBundle(WF, defWithCode('return { body: "old" }'), ACCT, TOKEN, kv)
    const b = await deployTestCodeBundle(WF, defWithCode('return { body: "new" }'), ACCT, TOKEN, kv)
    expect(a.bundleName).not.toBe(b.bundleName)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('returns null bundle name when there are no code nodes', async () => {
    const kv = makeKv()
    const def = { nodes: [{ id: 'r', type: 'response', namespace: 'r', config: {} }], edges: [], trigger: { type: 'http_webhook', config: {} } } as unknown as WorkflowDefinition
    const { bundleName } = await deployTestCodeBundle(WF, def, ACCT, TOKEN, kv)
    expect(bundleName).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('deleteTestBundles', () => {
  it('deletes every tracked bundle and clears the tracking key', async () => {
    const kv = makeKv()
    await deployTestCodeBundle(WF, defWithCode('return { a: 1 }'), ACCT, TOKEN, kv)
    await deployTestCodeBundle(WF, defWithCode('return { a: 2 }'), ACCT, TOKEN, kv)
    const tracked = JSON.parse(kv.store.get(`test-bundles-${WF}`) as string) as string[]
    expect(tracked.length).toBe(2)

    vi.mocked(fetch).mockClear()
    await deleteTestBundles(WF, ACCT, TOKEN, kv)

    const deleteCalls = vi.mocked(fetch).mock.calls.filter(([, opts]) => (opts as RequestInit)?.method === 'DELETE')
    expect(deleteCalls.length).toBe(2)
    expect(kv.store.get(`test-bundles-${WF}`)).toBeUndefined()
  })

  it('no-ops when nothing is tracked', async () => {
    const kv = makeKv()
    await deleteTestBundles(WF, ACCT, TOKEN, kv)
    expect(fetch).not.toHaveBeenCalled()
  })
})
