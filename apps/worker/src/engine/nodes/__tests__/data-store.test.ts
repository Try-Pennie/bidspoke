import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeDataStoreNode } from '../data-store'
import type { ExecutionContext, NodeDefinition } from '../../../types'
import type { Env } from '../../../index'

// ── Test fakes ────────────────────────────────────────────────────────────────

interface KVRow {
  value: string
  ttl: number | undefined
}

function makeFakeKv() {
  const store = new Map<string, KVRow>()
  const put = vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
    store.set(key, { value, ttl: opts?.expirationTtl })
  })
  const get = vi.fn(async (key: string) => store.get(key)?.value ?? null)
  const del = vi.fn(async (key: string) => {
    store.delete(key)
  })
  return {
    put,
    get,
    delete: del,
    list: vi.fn(),
    getWithMetadata: vi.fn(),
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, KVRow> }
}

function makeCtx(overrides: Partial<ExecutionContext['trigger']> = {}): ExecutionContext {
  return {
    trigger: {
      payload: { Submission__c: 'sub-abc' },
      source: 'test',
      workflow_id: 'wf-1',
      org_id: 'org-1',
      trace_id: 'trace-1',
      ...overrides,
    },
    steps: {
      engine_call: {
        status: 'completed',
        output: { uuid: 'eng-uuid-123', leadUuid: 'lead-456' },
      },
    },
    env: {},
  }
}

function node(config: NodeDefinition['config']): NodeDefinition {
  return { id: 'n1', namespace: 'engine_uuid_cache', type: 'data_store', config }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('executeDataStoreNode', () => {
  let kv: KVNamespace & { _store: Map<string, KVRow> }
  let env: Env

  beforeEach(() => {
    kv = makeFakeKv()
    env = { SUBMISSIONS: kv } as unknown as Env
  })

  describe('set', () => {
    it('writes a JSON-encoded value with TTL', async () => {
      const result = await executeDataStoreNode(
        node({
          store: 'submissions',
          operation: 'set',
          key: 'sub-abc',
          value: 'eng-uuid-123',
          ttl_seconds: 604800,
        }),
        makeCtx(),
        env
      )

      expect(kv._store.get('sub-abc')).toEqual({
        value: JSON.stringify('eng-uuid-123'),
        ttl: 604800,
      })
      expect(result.output).toEqual({
        store: 'submissions',
        operation: 'set',
        key: 'sub-abc',
        ttl_seconds: 604800,
      })
    })

    it('resolves templates in key and value', async () => {
      await executeDataStoreNode(
        node({
          store: 'submissions',
          operation: 'set',
          key: '{{trigger.payload.Submission__c}}',
          value: '{{steps.engine_call.output.uuid}}',
          ttl_seconds: 604800,
        }),
        makeCtx(),
        env
      )
      expect(kv._store.get('sub-abc')).toEqual({
        value: JSON.stringify('eng-uuid-123'),
        ttl: 604800,
      })
    })

    it('clamps TTL up to KV minimum (60 seconds)', async () => {
      await executeDataStoreNode(
        node({
          store: 'submissions',
          operation: 'set',
          key: 'sub-abc',
          value: 'whatever',
          ttl_seconds: 10,
        }),
        makeCtx(),
        env
      )
      expect(kv._store.get('sub-abc')?.ttl).toBe(60)
    })

    it('omits TTL entirely when not provided', async () => {
      await executeDataStoreNode(
        node({
          store: 'submissions',
          operation: 'set',
          key: 'sub-abc',
          value: 'whatever',
        }),
        makeCtx(),
        env
      )
      expect(kv._store.get('sub-abc')?.ttl).toBeUndefined()
    })

    it('stores nested object values', async () => {
      const value = { engine: { uuid: 'eng-1', leadUuid: 'lead-2' } }
      await executeDataStoreNode(
        node({ store: 'submissions', operation: 'set', key: 'sub-abc', value }),
        makeCtx(),
        env
      )
      expect(JSON.parse(kv._store.get('sub-abc')!.value)).toEqual(value)
    })
  })

  describe('get', () => {
    it('returns the parsed value with hit: true', async () => {
      await kv.put('sub-abc', JSON.stringify('eng-uuid-123'))
      const result = await executeDataStoreNode(
        node({ store: 'submissions', operation: 'get', key: 'sub-abc' }),
        makeCtx(),
        env
      )
      expect(result.output).toEqual({
        store: 'submissions',
        operation: 'get',
        key: 'sub-abc',
        value: 'eng-uuid-123',
        hit: true,
      })
    })

    it('returns null value with hit: false on miss', async () => {
      const result = await executeDataStoreNode(
        node({ store: 'submissions', operation: 'get', key: 'missing' }),
        makeCtx(),
        env
      )
      expect(result.output).toEqual({
        store: 'submissions',
        operation: 'get',
        key: 'missing',
        value: null,
        hit: false,
      })
    })

    it('falls back to raw string when stored value is not valid JSON', async () => {
      await kv.put('legacy', 'not-json{')
      const result = await executeDataStoreNode(
        node({ store: 'submissions', operation: 'get', key: 'legacy' }),
        makeCtx(),
        env
      )
      expect((result.output as { value: unknown }).value).toBe('not-json{')
    })
  })

  describe('delete', () => {
    it('removes the key from KV', async () => {
      await kv.put('sub-abc', JSON.stringify('val'))
      const result = await executeDataStoreNode(
        node({ store: 'submissions', operation: 'delete', key: 'sub-abc' }),
        makeCtx(),
        env
      )
      expect(kv._store.has('sub-abc')).toBe(false)
      expect(result.output).toEqual({
        store: 'submissions',
        operation: 'delete',
        key: 'sub-abc',
      })
    })
  })

  describe('validation', () => {
    it('throws when operation is missing', async () => {
      await expect(
        executeDataStoreNode(node({ key: 'x' }), makeCtx(), env)
      ).rejects.toThrow(/operation/)
    })

    it('throws when key is missing', async () => {
      await expect(
        executeDataStoreNode(node({ operation: 'set' }), makeCtx(), env)
      ).rejects.toThrow(/key/)
    })

    it('throws when resolved key is empty', async () => {
      await expect(
        executeDataStoreNode(
          node({ operation: 'get', key: '{{trigger.payload.does_not_exist}}' }),
          makeCtx(),
          env
        )
      ).rejects.toThrow(/empty key/)
    })

    it('throws for unknown store', async () => {
      await expect(
        executeDataStoreNode(
          node({ store: 'unknown' as 'submissions', operation: 'get', key: 'x' }),
          makeCtx(),
          env
        )
      ).rejects.toThrow(/unknown store/)
    })
  })
})
