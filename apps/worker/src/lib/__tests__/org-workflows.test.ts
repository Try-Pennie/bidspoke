/**
 * readOrgWorkflows (#2142): the one organization scoped read of workflows with
 * their definitions. The Worker is service_role, so this read is the scoping.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readOrgWorkflows } from '../org-workflows'
import { makeSupabase } from '../../routes/api/__tests__/_supabase-mock'

const ORG = 'org-abc'
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Workflow ${id}`,
  is_active: true,
  definition: { nodes: [] },
  organization_id: ORG,
  deleted_at: null,
  updated_at: '2026-10-15T12:00:00.123456+00:00',
  ...over,
})

const asClient = (sb: ReturnType<typeof makeSupabase>) => sb as unknown as SupabaseClient

afterEach(() => vi.restoreAllMocks())

describe('readOrgWorkflows', () => {
  it('filters by the organization and by deleted_at in the query, and pages in id order', async () => {
    const sb = makeSupabase({ workflows: { list: [row('a')] } })
    await readOrgWorkflows(asClient(sb), ORG)
    const chain = sb.calls.workflows
    expect(chain).toContainEqual(['eq', ['organization_id', ORG]])
    expect(chain).toContainEqual(['is', ['deleted_at', null]])
    expect(chain).toContainEqual(['order', ['id', { ascending: true }]])
    expect(chain).toContainEqual(['range', [0, 999]])
  })

  it('includes inactive workflows with is_active false, unless the caller asks for active ones only', async () => {
    const sb = () => makeSupabase({ workflows: { list: [row('on'), row('off', { is_active: false })] } })
    const all = await readOrgWorkflows(asClient(sb()), ORG)
    expect(all.map((w) => [w.id, w.is_active])).toEqual([['on', true], ['off', false]])
    const liveSb = sb()
    const live = await readOrgWorkflows(asClient(liveSb), ORG, { activeOnly: true })
    expect(live.map((w) => w.id)).toEqual(['on'])
    expect(liveSb.calls.workflows).toContainEqual(['eq', ['is_active', true]])
  })

  it('never hands back a row of another organization or a soft deleted one, and logs the broken scoping', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sb = makeSupabase({ workflows: { list: [row('mine'), row('theirs', { organization_id: 'org-other' }), row('gone', { deleted_at: '2026-10-01T00:00:00Z' })] } })
    const got = await readOrgWorkflows(asClient(sb), ORG)
    expect(got.map((w) => w.id)).toEqual(['mine'])
    expect(err).toHaveBeenCalledTimes(2)
  })

  it('carries each workflow\'s updated_at exactly as read, for the delete check\'s fingerprint (#2140)', async () => {
    const sb = makeSupabase({ workflows: { list: [row('a', { updated_at: '2026-10-16T01:02:03.456789+00:00' })] } })
    const got = await readOrgWorkflows(asClient(sb), ORG)
    expect(sb.calls.workflows.find(([m]) => m === 'select')?.[1][0]).toMatch(/\bupdated_at\b/)
    expect(got[0].updated_at).toBe('2026-10-16T01:02:03.456789+00:00')
  })

  it('leaves out a named workflow in the query, so it never takes a page slot', async () => {
    const sb = makeSupabase({ workflows: { list: [row('other')] } })
    const got = await readOrgWorkflows(asClient(sb), ORG, { excludeId: 'self' })
    expect(sb.calls.workflows).toContainEqual(['neq', ['id', 'self']])
    expect(got.map((w) => w.id)).toEqual(['other'])
  })

  it('never hands back the excluded workflow even if the query lets it through', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sb = makeSupabase({ workflows: { list: [row('self'), row('other')] } })
    const got = await readOrgWorkflows(asClient(sb), ORG, { excludeId: 'self' })
    expect(got.map((w) => w.id)).toEqual(['other'])
  })

  it('reads past the 1,000 row cap', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => row(`w${String(i).padStart(4, '0')}`))
    const sb = makeSupabase({ workflows: [{ list: page1 }, { list: [row('w1000')] }] })
    const got = await readOrgWorkflows(asClient(sb), ORG)
    expect(got).toHaveLength(1001)
    expect(sb.calls.workflows).toContainEqual(['range', [1000, 1999]])
  })

  it('throws on a failed read rather than answering an empty list', async () => {
    const sb = makeSupabase({ workflows: { listError: { message: 'connection refused' } } })
    await expect(readOrgWorkflows(asClient(sb), ORG)).rejects.toThrow(/connection refused/)
  })

  it('refuses rather than truncates when the last row is not reached within its page bound', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => row(`w${i}`))
    const sb = makeSupabase({ workflows: { list: full } })
    await expect(readOrgWorkflows(asClient(sb), ORG)).rejects.toThrow(/did not reach its last row/)
  })
})
