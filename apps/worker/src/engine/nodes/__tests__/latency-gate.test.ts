import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeLatencyGateNode } from '../latency-gate'
import type { ExecutionContext, NodeDefinition } from '../../../types'
import type { Env } from '../../../index'
import type { SupabaseClient } from '@supabase/supabase-js'

// ── Test fakes ────────────────────────────────────────────────────────────────

interface MarkRow {
  marked_at: number
  ttl_seconds: number
}

// Stand-in for the LATENCY_MARK Durable Object namespace. A DO is one instance per
// name, globally, so a read always sees the latest write no matter which colo asks.
// That strong consistency is the entire point of #488, so the fake models it: the
// store is shared and a write is immediately visible.
function makeFakeMarkStore() {
  const store = new Map<string, MarkRow>()
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (url: string, init?: { body?: string }) => {
        const path = new URL(url).pathname
        if (path === '/mark') {
          const body = JSON.parse(init?.body ?? '{}') as MarkRow
          store.set(id.name, { marked_at: body.marked_at, ttl_seconds: body.ttl_seconds })
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (path === '/check') {
          const row = store.get(id.name)
          return new Response(JSON.stringify({ marked_at: row?.marked_at ?? null }), { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      },
    }),
  }
  return { store, ns: ns as unknown as DurableObjectNamespace }
}

// KV as it actually behaves across colos: a write is NOT visible to a read in
// another colo for up to 60s. Any implementation that correlates the mark to the
// check through this will reject a confirmation that comes back quickly, which is
// exactly backwards (#488).
function makeEventuallyConsistentKv() {
  const store = new Map<string, string>()
  return {
    put: vi.fn(async () => {
      // The write is accepted, and is invisible to this test's reads. That is the
      // window a fast confirmation lands in.
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    delete: vi.fn(async () => {}),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace
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
  let marks: Map<string, MarkRow>
  let env: Env

  beforeEach(() => {
    const store = makeFakeMarkStore()
    marks = store.store
    // SUBMISSIONS is still bound, and is deliberately the eventually-consistent fake:
    // if the node ever correlates marks through KV again, the cross-colo test below
    // fails rather than quietly passing.
    env = { LATENCY_MARK: store.ns, SUBMISSIONS: makeEventuallyConsistentKv() } as unknown as Env
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
      expect(marks.get('latency:lead-abc')).toEqual({ marked_at: NOW, ttl_seconds: 86400 })
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
      expect(marks.has('latency:lead_economy:lead-abc')).toBe(true)
    })

    it('clamps TTL up to the KV minimum (60s)', async () => {
      await executeLatencyGateNode(
        node({ operation: 'mark', correlation_key: 'lead-abc', ttl_seconds: 10 }),
        makeCtx(),
        env
      )
      expect(marks.get('latency:lead-abc')?.ttl_seconds).toBe(60)
    })
  })

  // #488. The mark is written by whichever colo served the bid; the confirmation can
  // land in a different one. KV takes up to 60s to propagate, and a missing mark is
  // rejected, so correlating through KV rejects exactly the confirmations that came
  // back FASTEST, since those are the ones that beat propagation. The gate is meant
  // to reject SLOW confirmations, so it was inverted for the leads that mattered most.
  //
  // Nothing about a retry or a longer TTL fixes that: inside the propagation window a
  // not-yet-replicated mark and a never-written mark are the same empty read. The mark
  // has to live somewhere strongly consistent, which is what the Durable Object is.
  describe('cross-colo correlation (#488)', () => {
    it('accepts a confirmation that comes back before KV could have propagated the mark', async () => {
      // Bid: marked in colo A.
      await executeLatencyGateNode(
        node({ operation: 'mark', correlation_key: 'lead-abc' }),
        makeCtx(),
        env
      )

      // Confirmation arrives 2s later in colo B, well inside the threshold, and well
      // inside KV's propagation window.
      vi.spyOn(Date, 'now').mockReturnValue(NOW + 2000)
      const result = await executeLatencyGateNode(
        node({ operation: 'check', correlation_key: 'lead-abc', threshold_ms: 5000 }),
        makeCtx(),
        env
      )

      expect(result.output).toMatchObject({
        hit: true,
        latency_ms: 2000,
        within_threshold: true,
        _route: 'within',
      })
    })

    it('still rejects a genuinely absent mark, so the gate stays fail-safe', async () => {
      // Strong consistency means "not found" now really does mean never marked (or
      // expired), rather than "maybe not replicated yet". So the fail-safe reject is
      // finally trustworthy instead of firing on healthy traffic.
      const result = await executeLatencyGateNode(
        node({ operation: 'check', correlation_key: 'never-bid-on', threshold_ms: 5000 }),
        makeCtx(),
        env
      )
      expect(result.output).toMatchObject({
        hit: false,
        _route: 'exceeded',
        reason: 'mark_not_found',
      })
    })
  })

  describe('check', () => {
    function seedMark(key: string, markedAt: number) {
      marks.set(key, { marked_at: markedAt, ttl_seconds: 86400 })
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
