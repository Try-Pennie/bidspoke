import { describe, it, expect, beforeEach } from 'vitest'
import {
  checkIdempotency,
  setIdempotencyProcessing,
  setIdempotencyResult,
} from '../idempotency'

// ── In-memory KV mock ─────────────────────────────────────────────────────────

function makeKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    async get(key: string, type?: string) {
      const raw = store.get(key)
      if (raw === undefined) return null
      return type === 'json' ? JSON.parse(raw) : raw
    },
    async put(key: string, value: string) {
      store.set(key, value)
    },
    async delete(key: string) {
      store.delete(key)
    },
    async list() { return { keys: [], list_complete: true, cursor: '' } },
    async getWithMetadata() { return { value: null, metadata: null } },
  } as unknown as KVNamespace
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('checkIdempotency', () => {
  it('returns null when no entry exists', async () => {
    const kv = makeKV()
    const result = await checkIdempotency(kv, 'wf-1', 'key-abc')
    expect(result).toBeNull()
  })

  it('returns the stored state when an entry exists', async () => {
    const kv = makeKV()
    await setIdempotencyProcessing(kv, 'wf-1', 'key-abc', 300)
    const result = await checkIdempotency(kv, 'wf-1', 'key-abc')
    expect(result).toEqual({ status: 'processing' })
  })

  it('different workflow IDs are isolated', async () => {
    const kv = makeKV()
    await setIdempotencyProcessing(kv, 'wf-1', 'key-abc', 300)
    const result = await checkIdempotency(kv, 'wf-2', 'key-abc')
    expect(result).toBeNull()
  })

  it('different idempotency keys are isolated', async () => {
    const kv = makeKV()
    await setIdempotencyProcessing(kv, 'wf-1', 'key-abc', 300)
    const result = await checkIdempotency(kv, 'wf-1', 'key-xyz')
    expect(result).toBeNull()
  })
})

describe('setIdempotencyProcessing', () => {
  it('stores status=processing with no response', async () => {
    const kv = makeKV()
    await setIdempotencyProcessing(kv, 'wf-1', 'key-1', 300)
    const state = await checkIdempotency(kv, 'wf-1', 'key-1')
    expect(state).toEqual({ status: 'processing' })
    expect(state?.response).toBeUndefined()
  })
})

describe('setIdempotencyResult', () => {
  it('stores status=complete with the response', async () => {
    const kv = makeKV()
    const response = { message: 'approved', score: 750 }
    await setIdempotencyResult(kv, 'wf-1', 'key-1', response, 300)
    const state = await checkIdempotency(kv, 'wf-1', 'key-1')
    expect(state).toEqual({ status: 'complete', response })
  })

  it('overwrites a processing state with complete', async () => {
    const kv = makeKV()
    await setIdempotencyProcessing(kv, 'wf-1', 'key-1', 300)
    await setIdempotencyResult(kv, 'wf-1', 'key-1', { ok: true }, 300)
    const state = await checkIdempotency(kv, 'wf-1', 'key-1')
    expect(state?.status).toBe('complete')
    expect(state?.response).toEqual({ ok: true })
  })
})

// ── State machine flow ────────────────────────────────────────────────────────

describe('idempotency state machine', () => {
  let kv: KVNamespace

  beforeEach(() => { kv = makeKV() })

  it('in-flight duplicate: processing state signals 409', async () => {
    await setIdempotencyProcessing(kv, 'wf-1', 'ik-1', 300)
    const state = await checkIdempotency(kv, 'wf-1', 'ik-1')
    // The caller (executeWorkflow) returns 409 when status === 'processing'
    expect(state?.status).toBe('processing')
  })

  it('completed duplicate: complete state signals cached replay', async () => {
    const cachedResponse = { approved: true, offer: '$500' }
    await setIdempotencyResult(kv, 'wf-1', 'ik-1', cachedResponse, 300)
    const state = await checkIdempotency(kv, 'wf-1', 'ik-1')
    expect(state?.status).toBe('complete')
    expect(state?.response).toEqual(cachedResponse)
  })

  it('full lifecycle: null → processing → complete', async () => {
    expect(await checkIdempotency(kv, 'wf-1', 'ik-1')).toBeNull()

    await setIdempotencyProcessing(kv, 'wf-1', 'ik-1', 300)
    expect((await checkIdempotency(kv, 'wf-1', 'ik-1'))?.status).toBe('processing')

    await setIdempotencyResult(kv, 'wf-1', 'ik-1', { done: true }, 300)
    expect((await checkIdempotency(kv, 'wf-1', 'ik-1'))?.status).toBe('complete')
  })
})
