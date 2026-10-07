/**
 * A bid group names each partner attempt by the partner's slug (bid_race.tripoint),
 * and that name is what later steps, the step rows and the sightings read. The
 * slugs came from a partner_configs read with no stored copy, so with the
 * database down every attempt was named partner-0, partner-1 (#1849, found by the
 * outage drill, #1305): the Main Flow's Bid Race then took another path than it
 * takes with the database up. The slugs now come from the partner constants
 * loader, whose stored copy is served when the database cannot be read.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { NodeDefinition, EdgeDefinition, ExecutionContext } from '../../types'
import type { StepLogEntry } from '../step-logger'

vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))
vi.mock('../nodes/partner-bid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../nodes/partner-bid')>()
  return { ...actual, executePartnerBidNode: vi.fn() }
})
vi.mock('../nodes/index', () => ({
  executeNode: vi.fn(async (node: NodeDefinition) => ({ output: { reached: node.namespace } })),
}))

import { walkGraph } from '../index'
import { buildContext } from '../context'
import { executePartnerBidNode } from '../nodes/partner-bid'
import { confirmedAt } from '../../lib/stored-copy-age'

const GROUP_ID = '0192a4f0-0000-7000-8000-00000000b1d1'
const TRIPOINT_ID = '1b9cbd8f-1d23-496c-b046-b11d64edae29'
const AMONE_ID = '58d50fe7-3e86-4d71-85c7-4533ab08acb0'

/** A database that refuses every read, as in an outage. */
function downDatabase(): SupabaseClient {
  const answer = { data: null, error: { message: 'TypeError: fetch failed', code: '' }, count: null, status: 0, statusText: '' }
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit', 'single', 'maybeSingle', 'retry', 'abortSignal']) chain[m] = () => chain
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answer).then(resolve)
  return { from: () => chain } as unknown as SupabaseClient
}

/** KV with metadata, as the stored copies use it since #1847 (when each was last confirmed). */
function memoryKv(initial: Record<string, { value: string; metadata?: unknown }>) {
  const store = new Map(Object.entries(initial))
  return {
    get: async (k: string, type?: string) => {
      const e = store.get(k)
      if (e === undefined) return null
      return type === 'json' ? JSON.parse(e.value) : e.value
    },
    getWithMetadata: async (k: string) => {
      const e = store.get(k)
      return { value: e?.value ?? null, metadata: e?.metadata ?? null }
    },
    put: async (k: string, value: string, opts?: { metadata?: unknown }) => { store.set(k, { value, metadata: opts?.metadata }) },
    delete: async (k: string) => { store.delete(k) },
  } as unknown as KVNamespace
}

const group: NodeDefinition = { id: GROUP_ID, namespace: 'bid_race', type: 'bid_group', config: { mode: 'highest_bid', partner_ids: [TRIPOINT_ID, AMONE_ID] } }
const afterWin: NodeDefinition = { id: 'n-win', namespace: 'after_winner', type: 'code', config: {} }
const afterLoss: NodeDefinition = { id: 'n-loss', namespace: 'after_no_winner', type: 'code', config: {} }
const edges: EdgeDefinition[] = [
  { id: 'e-win', source: GROUP_ID, target: afterWin.id, source_handle: 'winner' },
  { id: 'e-loss', source: GROUP_ID, target: afterLoss.id, source_handle: 'no_winner' },
]

beforeEach(() => {
  vi.mocked(executePartnerBidNode).mockReset()
  vi.mocked(executePartnerBidNode).mockImplementation(async (node: NodeDefinition, _ctx: ExecutionContext) => ({
    output: { partner_id: node.config.partner_id, bid: 10, accepted: true, skipped: false },
  }))
})

async function namesWith(orgId: string, kvEntries: Record<string, { value: string; metadata?: unknown }>): Promise<string[]> {
  const env = { PII_REDACTION_FIELDS: '', WORKFLOW_CACHE: memoryKv(kvEntries) } as unknown as Env
  const queue: StepLogEntry[] = []
  await walkGraph(buildContext({}, 'web', 'wf-1', 'trace-1', {}, orgId, 'exec-1'), { nodes: [group, afterWin, afterLoss], edges }, 'exec-1', '2027-09-23T15:30:00.000Z', downDatabase(), env, 'money', 'v1', queue)
  return queue.filter((r) => r.step_type === 'partner_bid').map((r) => r.step_namespace).sort()
}

describe('bid group partner names with the database down (#1849)', () => {
  it('names each attempt by its slug from the stored partner constants copy', async () => {
    const copy = { subAccountIdsMap: {}, sellOff: {}, clickUrls: {}, activeBidding: {}, subAccountMinBids: {}, slugsById: { [TRIPOINT_ID]: 'tripoint', [AMONE_ID]: 'amone' } }
    // Confirmed a minute ago, well inside the 30 minute maximum (#1847).
    const entry = { value: JSON.stringify(copy), ...confirmedAt(Date.now() - 60_000) }
    expect(await namesWith('org-down-copy', { 'partner-constants-v2-org-down-copy-lastgood': entry })).toEqual(['bid_race.amone', 'bid_race.tripoint'])
  })

  it('still bids, under positional names, when there is no copy at all', async () => {
    expect(await namesWith('org-down-nocopy', {})).toEqual(['bid_race.partner-0', 'bid_race.partner-1'])
  })
})
