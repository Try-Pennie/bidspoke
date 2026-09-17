/**
 * The one place a partner block sighting is reported from (#1265).
 *
 * Node executors cannot reach the Cloudflare context, a Supabase client or the Worker Env
 * uniformly, so a sighting rides on the step result, or on the thrown error the way `logs`
 * and `resolvedInput` already do, and walkGraph hands every one to a single callback. The
 * caller (executeWorkflow) turns that callback into a background report. This proves the
 * walker forwards sightings from BOTH paths, a completed step and a failed one, and never
 * lets the callback's own failure touch the walk.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { NodeDefinition, PartnerBlockSighting, WorkflowDefinition } from '../../types'

vi.mock('../step-logger', () => ({
  logStep: vi.fn(),
  flushStepLogs: vi.fn(async () => undefined),
}))
vi.mock('../nodes/index', () => ({ executeNode: vi.fn() }))

import { walkGraph } from '../index'
import { executeNode } from '../nodes/index'
import { buildContext } from '../context'

const env = { PII_REDACTION_FIELDS: '' } as unknown as Env
const supabase = {} as unknown as SupabaseClient

const sighting = (host: string): PartnerBlockSighting => ({
  host, status: 403, vendor: 'cloudflare', bodyRayId: 'a369312f2f2faa85', edgeRayId: null,
  markers: ['Sorry, you have been blocked'], seenIn: 'scout',
})

function twoStepDefinition(): WorkflowDefinition {
  const nodes: NodeDefinition[] = [
    { id: 'a', namespace: 'scout', type: 'webhook', config: { retries: 0 } } as NodeDefinition,
    { id: 'b', namespace: 'answer', type: 'response', config: { retries: 0 } } as NodeDefinition,
  ]
  return { nodes, edges: [{ id: 'e', source: 'a', target: 'b' }], trigger: { type: 'http_webhook', config: {} } } as unknown as WorkflowDefinition
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('walkGraph forwards partner block sightings (#1265)', () => {
  it('from a completed step result', async () => {
    vi.mocked(executeNode)
      .mockResolvedValueOnce({ output: { ok: false }, blockSightings: [sighting('oauth.prd.ffngcp.com')] })
      .mockResolvedValueOnce({ output: null })
    const seen: PartnerBlockSighting[] = []
    const ctx = buildContext({}, 'src', 'wf-1', 'trace-1', {}, 'org-1')
    await walkGraph(ctx, twoStepDefinition(), 'exec-1', new Date().toISOString(), supabase, env, '', [], undefined, (s) => { seen.push(s) })
    expect(seen.map((s) => s.host)).toEqual(['oauth.prd.ffngcp.com'])
  })

  it('from a thrown error carrying sightings, even when the step fails the run', async () => {
    const err = new Error('Partner API returned 403') as Error & { blockSightings?: PartnerBlockSighting[] }
    err.blockSightings = [sighting('api.freedomfinancialnet.com')]
    vi.mocked(executeNode).mockRejectedValueOnce(err)
    const seen: PartnerBlockSighting[] = []
    const ctx = buildContext({}, 'src', 'wf-1', 'trace-1', {}, 'org-1')
    await expect(
      walkGraph(ctx, twoStepDefinition(), 'exec-1', new Date().toISOString(), supabase, env, '', [], undefined, (s) => { seen.push(s) }),
    ).rejects.toThrow('Partner API returned 403')
    expect(seen.map((s) => s.host)).toEqual(['api.freedomfinancialnet.com'])
  })

  it('a callback that throws does not fail the walk', async () => {
    vi.mocked(executeNode)
      .mockResolvedValueOnce({ output: 1, blockSightings: [sighting('oauth.prd.ffngcp.com')] })
      .mockResolvedValueOnce({ output: null })
    const ctx = buildContext({}, 'src', 'wf-1', 'trace-1', {}, 'org-1')
    const result = await walkGraph(ctx, twoStepDefinition(), 'exec-1', new Date().toISOString(), supabase, env, '', [], undefined, () => { throw new Error('reporter broke') })
    expect(result).toBeDefined()
  })

  it('with no callback a sighting is simply carried, not an error', async () => {
    vi.mocked(executeNode)
      .mockResolvedValueOnce({ output: 1, blockSightings: [sighting('oauth.prd.ffngcp.com')] })
      .mockResolvedValueOnce({ output: null })
    const ctx = buildContext({}, 'src', 'wf-1', 'trace-1', {}, 'org-1')
    await expect(walkGraph(ctx, twoStepDefinition(), 'exec-1', new Date().toISOString(), supabase, env)).resolves.toBeDefined()
  })
})
