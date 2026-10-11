import { describe, it, expect } from 'vitest'
import {
  createSupabaseClient,
  withRequestDeadline,
  SupabaseRequestTimeoutError,
  SUPABASE_REQUEST_DEADLINE_MS,
} from '../supabase'
import type { Env } from '../../index'

/** A fetch that never answers on its own; it settles only when its signal aborts. */
function hangingFetch(): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      // reason is the abort reason, a DOMException (an Error); typed any, so cast.
      if (signal) signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true })
    })) as typeof fetch
}

// The Worker connects as service_role, which bypasses RLS. Local `wrangler dev`
// shares the real production Supabase project, so without a guard any local run
// can write anywhere in production (#669). These tests pin that guard.

const PROD_URL = 'https://xvrmivmpfykwwtriqwpg.supabase.co'
const LOCAL_URL = 'http://127.0.0.1:54321'

const WORKFLOW_ROW = { name: 'guard-test', organization_id: '00000000-0000-0000-0000-000000000000' }
const SIGHTING_ROW = {
  execution_id: '00000000-0000-0000-0000-000000000000',
  execution_started_at_et: '2026-07-16T10:00:00',
  execution_started_at_utc: '2026-07-16T14:00:00Z',
  trace_id: 'guard-test-trace',
  workflow_id: '00000000-0000-0000-0000-000000000000',
}

function envWith(overrides: Partial<Env>): Env {
  return {
    SUPABASE_URL: PROD_URL,
    SUPABASE_SECRET_KEY: 'test-service-role-key',
    ...overrides,
  } as unknown as Env
}

describe('createSupabaseClient prod-write guard', () => {
  describe('local dev pointed at a remote database, no opt-in', () => {
    const env = envWith({ LOCAL_DEV: 'true' })

    it('rejects insert', () => {
      const supabase = createSupabaseClient(env)
      expect(() => supabase.from('workflows').insert(WORKFLOW_ROW)).toThrow(/ALLOW_PROD_WRITES/)
    })

    it('rejects update', () => {
      const supabase = createSupabaseClient(env)
      expect(() => supabase.from('workflows').update(WORKFLOW_ROW)).toThrow(/ALLOW_PROD_WRITES/)
    })

    it('rejects upsert', () => {
      const supabase = createSupabaseClient(env)
      expect(() => supabase.from('workflows').upsert(WORKFLOW_ROW)).toThrow(/ALLOW_PROD_WRITES/)
    })

    it('rejects delete', () => {
      const supabase = createSupabaseClient(env)
      expect(() => supabase.from('workflows').delete()).toThrow(/ALLOW_PROD_WRITES/)
    })

    it('names the table in the error so the blocked write is identifiable', () => {
      const supabase = createSupabaseClient(env)
      expect(() => supabase.from('lead_sightings').insert(SIGHTING_ROW)).toThrow(/lead_sightings/)
    })

    it('still allows select, so local dev stays usable read-only', () => {
      const supabase = createSupabaseClient(env)
      expect(() => supabase.from('workflows').select('*')).not.toThrow()
    })

    it('still allows a read only rpc, which runs on every authed request', () => {
      const supabase = createSupabaseClient(env)
      expect(() => supabase.rpc('auth_user_with_allowlist', { p_user_id: 'x' })).not.toThrow()
    })

    // The rpc surface is guarded by an ALLOWLIST of read only names (#1409, L96).
    // The old comment claimed every rpc was read only; record_archive_day_measurement
    // already wrote, and save_buyer_profile is a user facing write path, so a local
    // run pointed at production could write through either with no opt in.
    it('rejects a mutating rpc by name', () => {
      const supabase = createSupabaseClient(env)
      expect(() => supabase.rpc('save_buyer_profile' as never, {} as never)).toThrow(/ALLOW_PROD_WRITES/)
      expect(() => supabase.rpc('record_archive_day_measurement' as never, {} as never)).toThrow(/record_archive_day_measurement/)
    })

    it('rejects an rpc that is on neither list, so an unclassified name fails closed', () => {
      const supabase = createSupabaseClient(env)
      expect(() => supabase.rpc('some_new_rpc_nobody_classified' as never, {} as never)).toThrow(/read-only-rpcs\.json/)
    })
  })

  it('allows a mutating rpc in local dev when ALLOW_PROD_WRITES opts in explicitly', () => {
    const supabase = createSupabaseClient(envWith({ LOCAL_DEV: 'true', ALLOW_PROD_WRITES: 'true' }))
    expect(() => supabase.rpc('save_buyer_profile' as never, {} as never)).not.toThrow()
  })

  it('leaves rpc alone in production, where LOCAL_DEV is unset', () => {
    const supabase = createSupabaseClient(envWith({}))
    expect(() => supabase.rpc('save_buyer_profile' as never, {} as never)).not.toThrow()
  })

  it('allows writes in local dev when ALLOW_PROD_WRITES opts in explicitly', () => {
    const supabase = createSupabaseClient(envWith({ LOCAL_DEV: 'true', ALLOW_PROD_WRITES: 'true' }))
    expect(() => supabase.from('workflows').insert(WORKFLOW_ROW)).not.toThrow()
  })

  it('allows writes in local dev against a localhost database', () => {
    const supabase = createSupabaseClient(envWith({ LOCAL_DEV: 'true', SUPABASE_URL: LOCAL_URL }))
    expect(() => supabase.from('workflows').insert(WORKFLOW_ROW)).not.toThrow()
  })

  // The guard must be completely inert in production, where LOCAL_DEV is never
  // set. A false positive here would block real lead writes.
  it('is inert in production, where LOCAL_DEV is unset', () => {
    const supabase = createSupabaseClient(envWith({}))
    expect(() => supabase.from('workflows').insert(WORKFLOW_ROW)).not.toThrow()
    expect(() => supabase.from('workflows').delete()).not.toThrow()
  })
})

describe('Supabase request deadline (#1484)', () => {
  it('sits above the 30s service_role statement_timeout, so a slow query fails with its own message', () => {
    expect(SUPABASE_REQUEST_DEADLINE_MS).toBeGreaterThan(30_000)
  })

  it('abandons a stalled request with a named timeout error', async () => {
    const wrapped = withRequestDeadline(hangingFetch(), 30)
    await expect(wrapped('https://example.test/anything')).rejects.toBeInstanceOf(SupabaseRequestTimeoutError)
  })

  it('names the method in the timeout message', async () => {
    const wrapped = withRequestDeadline(hangingFetch(), 30)
    await expect(wrapped('https://example.test/x', { method: 'POST' })).rejects.toThrow(/POST .* 30 ms/)
  })

  it('passes a fast response straight through', async () => {
    const ok = (() => Promise.resolve(new Response('[]', { status: 200 }))) as typeof fetch
    const wrapped = withRequestDeadline(ok, 1000)
    const res = await wrapped('https://example.test/x')
    expect(res.status).toBe(200)
  })

  it('still enforces its own deadline when a caller passes a longer signal', async () => {
    const wrapped = withRequestDeadline(hangingFetch(), 30)
    const longerCaller = AbortSignal.timeout(5_000)
    await expect(wrapped('https://example.test/x', { signal: longerCaller })).rejects.toBeInstanceOf(
      SupabaseRequestTimeoutError,
    )
  })

  it("defers to a caller's shorter deadline, propagating that caller's own abort reason", async () => {
    // The lead-read budget and the volume-cliff probe pass their own, shorter signal.
    // When that fires first, the exact error raised is theirs, not this wrapper's.
    const wrapped = withRequestDeadline(hangingFetch(), 5_000)
    const caller = AbortSignal.timeout(20)
    let thrown: unknown
    try {
      await wrapped('https://example.test/x', { signal: caller })
    } catch (e) {
      thrown = e
    }
    // The exact reason the caller's signal aborted with, not merely some other throw.
    expect(thrown).toBe(caller.reason)
    expect(thrown).not.toBeInstanceOf(SupabaseRequestTimeoutError)
  })

  it('wires the deadline onto every client request (an AbortSignal reaches the fetch)', async () => {
    let seenSignal: AbortSignal | null | undefined
    const recordingFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal
      return Promise.resolve(
        new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    }) as typeof fetch
    const supabase = createSupabaseClient(envWith({}), { fetch: recordingFetch })
    await supabase.from('workflows').select('*')
    expect(seenSignal, 'the client made a request with no abort signal, so it carries no deadline').toBeInstanceOf(
      AbortSignal,
    )
  })
})
