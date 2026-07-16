import { describe, it, expect } from 'vitest'
import { createSupabaseClient } from '../supabase'
import type { Env } from '../../index'

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

    it('still allows rpc, which is read-only here and runs on every authed request', () => {
      const supabase = createSupabaseClient(env)
      expect(() => supabase.rpc('auth_user_with_allowlist', { p_user_id: 'x' })).not.toThrow()
    })
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
