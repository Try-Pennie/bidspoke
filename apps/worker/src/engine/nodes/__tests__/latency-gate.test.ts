import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeLatencyGateNode } from '../latency-gate'
import type { ExecutionContext, NodeDefinition } from '../../../types'
import type { Env } from '../../../index'
import type { SupabaseClient } from '@supabase/supabase-js'

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

// Minimal supabase stub for the partner-threshold lookup path.
function makeFakeSupabase(window: number | null, notFound = false) {
  const single = vi.fn(async () =>
    notFound ? { data: null, error: { message: 'not found' } } : { data: { confirmation_window_ms: window }, error: null }
  )
  const eq = vi.fn(() => ({ single }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  return { from } as unknown as SupabaseClient
}

function makeCtx(overrides: Partial<ExecutionContext['trigger']> = {}): ExecutionContext {
  return {
    trigger: {
      payload: { lead_id: 'lead-abc' },
      source: 'lead_economy',
      workflow_id: 'wf-1',
      org_id: 'org-1',
      trace_id: 'trace-1',
      ...overrides,
    },
    steps: {},
    env: {},
  }
}

function node(config: NodeDefinition['config']): NodeDefinition {
  return { id: 'n1', namespace: 'latency_gate', type: 'latency_gate', config }
}

const NOW = 1_700_000_000_000

describe('executeLatencyGateNode', () => {
  let kv: KVNamespace & { _store: Map<string, KVRow> }
  let env: Env

  beforeEach(() => {
    kv = makeFakeKv()
    env = { SUBMISSIONS: kv } as unknown as Env
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('mark', () => {
    it('stores marked_at under a latency: key with a default TTL', async () => {
      const result = await executeLatencyGateNode(
        node({ operation: 'mark', correlation_key: 'lead-abc' }),
        makeCtx(),
        env
      )
      expect(kv._store.get('latency:lead-abc')).toEqual({
        value: JSON.stringify({ marked_at: NOW }),
        ttl: 86400,
      })
      expect(result.output).toEqual({
        operation: 'mark',
        key: 'latency:lead-abc',
        marked_at: NOW,
        ttl_seconds: 86400,
      })
    })

    it('resolves correlation_key templates and namespaces by scope', async () => {
      await executeLatencyGateNode(
        node({
          operation: 'mark',
          correlation_key: '{{trigger.payload.lead_id}}',
          scope: '{{trigger.source}}',
        }),
        makeCtx(),
        env
      )
      expect(kv._store.has('latency:lead_economy:lead-abc')).toBe(true)
    })

    it('clamps TTL up to the KV minimum (60s)', async () => {
      await executeLatencyGateNode(
        node({ operation: 'mark', correlation_key: 'lead-abc', ttl_seconds: 10 }),
        makeCtx(),
        env
      )
      expect(kv._store.get('latency:lead-abc')?.ttl).toBe(60)
    })
  })

  describe('check', () => {
    function seedMark(key: string, markedAt: number) {
      kv._store.set(key, { value: JSON.stringify({ marked_at: markedAt }), ttl: 86400 })
    }

    it('routes within when latency is at or under the threshold (override)', async () => {
      seedMark('latency:lead-abc', NOW - 3000)
      const result = await executeLatencyGateNode(
        node({ operation: 'check', correlation_key: 'lead-abc', threshold_ms: 5000 }),
        makeCtx(),
        env
      )
      expect(result.output).toEqual({
        operation: 'check',
        key: 'latency:lead-abc',
        hit: true,
        marked_at: NOW - 3000,
        latency_ms: 3000,
        threshold_ms: 5000,
        within_threshold: true,
        _route: 'within',
        reason: null,
      })
    })

    it('routes exceeded when latency is over the threshold (override)', async () => {
      seedMark('latency:lead-abc', NOW - 9000)
      const result = await executeLatencyGateNode(
        node({ operation: 'check', correlation_key: 'lead-abc', threshold_ms: 5000 }),
        makeCtx(),
        env
      )
      expect(result.output).toMatchObject({
        latency_ms: 9000,
        within_threshold: false,
        _route: 'exceeded',
        reason: 'latency_exceeded',
      })
    })

    it('routes exceeded with mark_not_found when the mark is missing/expired', async () => {
      const result = await executeLatencyGateNode(
        node({ operation: 'check', correlation_key: 'lead-abc', threshold_ms: 5000 }),
        makeCtx(),
        env
      )
      expect(result.output).toEqual({
        operation: 'check',
        key: 'latency:lead-abc',
        hit: false,
        marked_at: null,
        latency_ms: null,
        threshold_ms: 5000,
        within_threshold: false,
        _route: 'exceeded',
        reason: 'mark_not_found',
      })
    })

    it('resolves the threshold from the partner config when no override is set', async () => {
      seedMark('latency:lead-abc', NOW - 2000)
      const supabase = makeFakeSupabase(4000)
      const result = await executeLatencyGateNode(
        node({ operation: 'check', correlation_key: 'lead-abc', partner_id: 'p-1' }),
        makeCtx(),
        env,
        supabase
      )
      expect(result.output).toMatchObject({ threshold_ms: 4000, within_threshold: true, _route: 'within' })
    })

    it('throws when no override and no partner_id', async () => {
      await expect(
        executeLatencyGateNode(node({ operation: 'check', correlation_key: 'lead-abc' }), makeCtx(), env)
      ).rejects.toThrow(/threshold_ms or partner_id/)
    })

    it('throws when the partner has no confirmation_window_ms', async () => {
      const supabase = makeFakeSupabase(null)
      await expect(
        executeLatencyGateNode(
          node({ operation: 'check', correlation_key: 'lead-abc', partner_id: 'p-1' }),
          makeCtx(),
          env,
          supabase
        )
      ).rejects.toThrow(/no confirmation_window_ms/)
    })
  })

  describe('validation', () => {
    it('throws when operation is missing', async () => {
      await expect(
        executeLatencyGateNode(node({ correlation_key: 'x' }), makeCtx(), env)
      ).rejects.toThrow(/operation/)
    })

    it('throws when correlation_key is missing', async () => {
      await expect(
        executeLatencyGateNode(node({ operation: 'mark' }), makeCtx(), env)
      ).rejects.toThrow(/correlation_key/)
    })

    it('throws when the resolved correlation_key is empty', async () => {
      await expect(
        executeLatencyGateNode(
          node({ operation: 'mark', correlation_key: '{{trigger.payload.missing}}' }),
          makeCtx(),
          env
        )
      ).rejects.toThrow(/empty correlation_key/)
    })
  })
})
