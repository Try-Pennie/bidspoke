/**
 * The bidding budgets are marked on the step row they cut short (#3068).
 *
 * Both nodes here absorb their deadline: the step goes on and routes, it does
 * not fail. So the marker goes on the row of the step whose work the deadline
 * actually cut short, never on a parent that carried on:
 *
 *   - a highest bid race that stops waiting for a partner marks THAT partner's
 *     attempt row 'bid_group', whenever the attempt finally writes it; the bid
 *     group's own row, which completed, carries nothing. An attempt whose own
 *     bid request timer fired before the race ended keeps 'partner_bid';
 *   - a buyer select whose budget ended its walk marks its own row
 *     'buyer_select', since the budget is what stopped it; its routing is
 *     unchanged. A failure for another reason is never marked as the budget.
 *
 * Neither kind is 'step', so the step timeout audit and the daily writes
 * report, which count only 'step', mean what they did.
 *
 * The partner and buyer select executors are stand ins, as in the outbound
 * fields walk test: the walk, the bid group executor and the row writing are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { EdgeDefinition, NodeDefinition } from '../../types'
import type { StepLogEntry } from '../step-logger'
import type { StepExecutionResult } from '../../types'

vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))
vi.mock('../nodes/partner-bid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../nodes/partner-bid')>()
  return { ...actual, executePartnerBidNode: vi.fn() }
})
vi.mock('../nodes/buyer-select', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../nodes/buyer-select')>()
  return { ...actual, executeBuyerSelectNode: vi.fn(), productionDeps: vi.fn(() => ({})) }
})
vi.mock('../nodes/index', () => ({
  executeNode: vi.fn(async (node: NodeDefinition) => ({ output: { reached: node.namespace } })),
}))

import { walkGraph } from '../index'
import { buildContext } from '../context'
import { executePartnerBidNode } from '../nodes/partner-bid'
import { executeBuyerSelectNode, BUYER_SELECT_DECIDE_ONLY_DEADLINE_MS } from '../nodes/buyer-select'
import { markDeadline, PARTNER_BID_DEADLINE, BUYER_SELECT_DEADLINE, timeoutMarker, stepTimedOut } from '../step-timeout'

const env = { PII_REDACTION_FIELDS: '' } as unknown as Env
const supabase = {} as unknown as SupabaseClient
const GROUP_ID = '0192a4f0-0000-7000-8000-00000000b1d0'
const FAST = '1b9cbd8f-1d23-496c-b046-b11d64edae29'
const SLOW = '58d50fe7-3e86-4d71-85c7-4533ab08acb0'
const RACE_MS = 5_000

const edge = (source: string, target: string, source_handle?: string): EdgeDefinition => ({ id: `${source}-${target}`, source, target, ...(source_handle ? { source_handle } : {}) })

function race(config: Record<string, unknown> = {}) {
  const group: NodeDefinition = { id: GROUP_ID, namespace: 'bid_race', type: 'bid_group', config: { mode: 'highest_bid', partner_ids: [FAST, SLOW], timeout_ms: RACE_MS, ...config } }
  const win: NodeDefinition = { id: 'n-win', namespace: 'after_winner', type: 'code', config: {} }
  const loss: NodeDefinition = { id: 'n-loss', namespace: 'after_no_winner', type: 'code', config: {} }
  return { nodes: [group, win, loss], edges: [edge(GROUP_ID, win.id, 'winner'), edge(GROUP_ID, loss.id, 'no_winner')] }
}

const bid = (slug: string, amount: number): StepExecutionResult => ({ output: { partner: slug, bid: amount, accepted: true, skipped: false } })

/** The slow partner answers (or throws) only when the test says so. */
let releaseSlow: (outcome: { answer: StepExecutionResult } | { error: Error }) => void

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(executePartnerBidNode).mockReset()
  vi.mocked(executePartnerBidNode).mockImplementation(async (node: NodeDefinition) => {
    if (node.config.partner_id === FAST) return bid('fast', 20)
    return new Promise<StepExecutionResult>((resolve, reject) => {
      releaseSlow = (o) => ('answer' in o ? resolve(o.answer) : reject(o.error))
    })
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function walk(def: { nodes: NodeDefinition[]; edges: EdgeDefinition[] }, queue: StepLogEntry[]) {
  const run = walkGraph(buildContext({}, 'web', 'wf-1', 'trace-3068', {}, 'org-1', 'exec-3068'), def, 'exec-3068', '2026-10-29T12:00:00.000Z', supabase, env, 'money', 'v1', queue)
    .catch((e: unknown) => e)
  await vi.advanceTimersByTimeAsync(RACE_MS)
  return run
}

const attemptRows = (queue: StepLogEntry[]) => queue.filter((r) => r.step_type === 'partner_bid')
const groupRow = (queue: StepLogEntry[]) => queue.find((r) => r.step_type === 'bid_group')!

describe('a highest bid race that stops waiting for a partner (#3068)', () => {
  it('marks the late partner\'s attempt row when it lands, and neither the group row nor the partner that answered in time', async () => {
    const queue: StepLogEntry[] = []
    await walk(race(), queue)
    // The group completed and routed on the partner that answered; the slow one is still out.
    expect(groupRow(queue)).toMatchObject({ status: 'completed' })
    expect(groupRow(queue)).not.toHaveProperty('timeout_kind')
    expect(attemptRows(queue)).toHaveLength(1)
    expect(attemptRows(queue)[0]).not.toHaveProperty('timeout_kind')

    releaseSlow({ answer: bid('slow', 99) })
    await vi.advanceTimersByTimeAsync(0)
    const late = attemptRows(queue).find((r) => r.step_namespace !== attemptRows(queue)[0].step_namespace)!
    // What the partner did after is what the row records; the marker says the race had stopped waiting.
    expect(late).toMatchObject({ status: 'completed', timeout_kind: 'bid_group', timed_out_after_ms: RACE_MS })
    expect(stepTimedOut(late)).toBe(false)
  })

  it('a late partner that then fails on its own bid timer is still marked as the race\'s: that is the deadline the bidding saw', async () => {
    const queue: StepLogEntry[] = []
    await walk(race(), queue)
    releaseSlow({ error: markDeadline(new DOMException('The operation was aborted.', 'AbortError'), PARTNER_BID_DEADLINE, 15_000) })
    await vi.advanceTimersByTimeAsync(0)
    const late = attemptRows(queue).find((r) => r.status === 'failed')!
    expect(late).toMatchObject({ timeout_kind: 'bid_group', timed_out_after_ms: RACE_MS, error_type: 'transient' })
  })

  it('a partner whose own bid timer fires inside the race keeps the partner bid marker, and the group still completes', async () => {
    vi.mocked(executePartnerBidNode).mockImplementation(async (node: NodeDefinition) => {
      if (node.config.partner_id === FAST) return bid('fast', 20)
      throw markDeadline(new DOMException('The operation was aborted.', 'AbortError'), PARTNER_BID_DEADLINE, 15_000)
    })
    const queue: StepLogEntry[] = []
    await walk(race(), queue)
    expect(groupRow(queue)).toMatchObject({ status: 'completed' })
    expect(groupRow(queue)).not.toHaveProperty('timeout_kind')
    const failed = attemptRows(queue).find((r) => r.status === 'failed')!
    expect(failed).toMatchObject({ timeout_kind: 'partner_bid', timed_out_after_ms: 15_000, error_type: 'transient' })
  })

  it('a partner that fails in time for another reason carries no marker', async () => {
    vi.mocked(executePartnerBidNode).mockImplementation(async (node: NodeDefinition) => {
      if (node.config.partner_id === FAST) return bid('fast', 20)
      throw new DOMException('The operation was aborted.', 'AbortError')
    })
    const queue: StepLogEntry[] = []
    await walk(race(), queue)
    const failed = attemptRows(queue).find((r) => r.status === 'failed')!
    expect(failed.error_message).toMatch(/aborted/i)
    expect(failed).not.toHaveProperty('timeout_kind')
  })

  it('a race with no deadline marks nothing, however late a partner is', async () => {
    const queue: StepLogEntry[] = []
    const run = walk(race({ timeout_ms: undefined }), queue)
    await vi.advanceTimersByTimeAsync(60_000)
    releaseSlow({ answer: bid('slow', 99) })
    await run
    expect(queue.filter((r) => r.timeout_kind !== undefined)).toEqual([])
  })
})

describe('a buyer select whose budget ended its walk (#3068)', () => {
  const select: NodeDefinition = { id: '0192a4f0-0000-7000-8000-0000000000b5', namespace: 'buyer_select', type: 'buyer_select', config: { mode: 'decide_only' } }
  const after: NodeDefinition = { id: 'n-after', namespace: 'after_deferred', type: 'code', config: {} }
  const def = (handle: string) => ({ nodes: [select, after], edges: [edge(select.id, after.id, handle)] })
  const output = { _route: 'deferred', reason: 'rehearsal_deadline', mode_effective: 'decide_only', population: 'engine', lead_key: 'lead-1', sale: { skipped: true }, considered: [], live_percent_in_force: null, caps_in_force: [], duration_ms: 801 }

  it('marks its own row with the budget, and routes as it did', async () => {
    vi.mocked(executeBuyerSelectNode).mockResolvedValue({ output, attempts: [], deadline: timeoutMarker(BUYER_SELECT_DEADLINE, BUYER_SELECT_DECIDE_ONLY_DEADLINE_MS) } as never)
    const queue: StepLogEntry[] = []
    const result = await walk(def('deferred'), queue)
    expect(result).toMatchObject({ body: { reached: 'after_deferred' } })
    const row = queue.find((r) => r.step_type === 'buyer_select')!
    expect(row).toMatchObject({ status: 'completed', timeout_kind: 'buyer_select', timed_out_after_ms: BUYER_SELECT_DECIDE_ONLY_DEADLINE_MS })
    expect(stepTimedOut(row)).toBe(false)
  })

  it('a row that failed for another reason (its handle is not wired) is never marked as the budget', async () => {
    vi.mocked(executeBuyerSelectNode).mockResolvedValue({ output, attempts: [], deadline: timeoutMarker(BUYER_SELECT_DEADLINE, BUYER_SELECT_DECIDE_ONLY_DEADLINE_MS) } as never)
    const queue: StepLogEntry[] = []
    await walk(def('sold'), queue)
    const row = queue.find((r) => r.step_type === 'buyer_select')!
    expect(row.status).toBe('failed')
    expect(row).not.toHaveProperty('timeout_kind')
  })

  it('a result with no budget ending carries no marker', async () => {
    vi.mocked(executeBuyerSelectNode).mockResolvedValue({ output: { ...output, reason: 'no_eligible_buyer' }, attempts: [] } as never)
    const queue: StepLogEntry[] = []
    await walk(def('deferred'), queue)
    expect(queue.find((r) => r.step_type === 'buyer_select')).not.toHaveProperty('timeout_kind')
  })
})
