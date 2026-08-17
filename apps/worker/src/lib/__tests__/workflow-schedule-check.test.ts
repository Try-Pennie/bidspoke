import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../slack', () => ({
  sendWorkflowScheduleAlert: vi.fn(async () => true),
}))

import { sendWorkflowScheduleAlert } from '../slack'
import { runWorkflowScheduleWatch, WATCHED_WORKFLOWS } from '../workflow-schedule-watch'

/**
 * The orchestration half of the scheduled-workflow dead-man's-switch (#805):
 * which states reach Slack, how often, and which stay quiet.
 *
 * The decision itself is covered next door. What is covered here is the part
 * that can go wrong without any decision being wrong: alerting on every run of
 * an hourly check would make a single dark workflow produce 24 messages a day
 * and train everyone to ignore it (LESSONS L36), while staying quiet on a
 * lookup that could not be completed would leave a guard that is
 * indistinguishable from no guard at all (L98).
 */
const NOW = Date.parse('2026-08-17T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

const ENV = { GITHUB_TOKEN: 'tok', GITHUB_CODE_REPO: 'Try-Pennie/bidspoke' }

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => {
      store.set(k, v)
    }),
  } as unknown as KVNamespace & { store: Map<string, string> }
}

function fakeSupabase(orgRows: { organization_id: string }[]): SupabaseClient {
  return {
    from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: orgRows, error: null }) }) }),
  } as unknown as SupabaseClient
}

/** A fetch that answers every workflow with the same last-run timestamp. */
const fetchAll = (lastRunIso: string | null) =>
  vi.fn(async () =>
    new Response(
      JSON.stringify({ workflow_runs: lastRunIso === null ? [] : [{ created_at: lastRunIso }] }),
      { status: 200 },
    ),
  ) as unknown as typeof fetch

beforeEach(() => {
  vi.mocked(sendWorkflowScheduleAlert).mockClear()
})

describe('runWorkflowScheduleWatch: the quiet path', () => {
  it('says nothing when every watched workflow ran recently', async () => {
    const results = await runWorkflowScheduleWatch(
      fakeSupabase([{ organization_id: 'org-1' }]),
      fakeKv(),
      ENV,
      NOW,
      fetchAll(iso(NOW - 60_000)),
    )
    expect(results.every((r) => r.status === 'healthy')).toBe(true)
    expect(sendWorkflowScheduleAlert).not.toHaveBeenCalled()
  })

  it('checks every workflow in the registry, not just the first', async () => {
    const results = await runWorkflowScheduleWatch(
      fakeSupabase([{ organization_id: 'org-1' }]),
      fakeKv(),
      ENV,
      NOW,
      fetchAll(iso(NOW - 60_000)),
    )
    expect(results.map((r) => r.file).sort()).toEqual(WATCHED_WORKFLOWS.map((w) => w.file).sort())
  })
})

describe('runWorkflowScheduleWatch: a workflow that has gone dark', () => {
  it('alerts every Slack org once', async () => {
    const results = await runWorkflowScheduleWatch(
      fakeSupabase([{ organization_id: 'org-1' }, { organization_id: 'org-2' }]),
      fakeKv(),
      ENV,
      NOW,
      // Older than every window in the registry.
      fetchAll(iso(NOW - 40 * 3_600_000)),
    )
    expect(results.every((r) => r.status === 'stale')).toBe(true)
    // One call per org per dark workflow.
    expect(sendWorkflowScheduleAlert).toHaveBeenCalledTimes(2 * WATCHED_WORKFLOWS.length)
  })

  it('stays quiet on the next run while the cooldown holds', async () => {
    const kv = fakeKv()
    const fetchImpl = fetchAll(iso(NOW - 40 * 3_600_000))
    const supabase = fakeSupabase([{ organization_id: 'org-1' }])

    await runWorkflowScheduleWatch(supabase, kv, ENV, NOW, fetchImpl)
    vi.mocked(sendWorkflowScheduleAlert).mockClear()

    // An hour later, still dark. This check runs hourly, so without a cooldown a
    // single dark workflow would post 24 times a day.
    const second = await runWorkflowScheduleWatch(supabase, kv, ENV, NOW + 3_600_000, fetchImpl)
    expect(second.every((r) => r.status === 'stale')).toBe(true)
    expect(second.every((r) => r.alerted === false)).toBe(true)
    expect(sendWorkflowScheduleAlert).not.toHaveBeenCalled()
  })

  it('does not arm the cooldown when the alert was not delivered', async () => {
    // Otherwise a Slack outage during the first dark run buys six hours of
    // silence about a condition nobody was ever told.
    vi.mocked(sendWorkflowScheduleAlert).mockResolvedValue(false)
    const kv = fakeKv()
    await runWorkflowScheduleWatch(
      fakeSupabase([{ organization_id: 'org-1' }]),
      kv,
      ENV,
      NOW,
      fetchAll(iso(NOW - 40 * 3_600_000)),
    )
    expect([...kv.store.keys()].filter((k) => k.endsWith(':alerted'))).toEqual([])
    vi.mocked(sendWorkflowScheduleAlert).mockResolvedValue(true)
  })
})

describe('runWorkflowScheduleWatch: the check itself cannot see', () => {
  it('alerts rather than passing when the lookup fails', async () => {
    // The L98 case. A check that could not read is not a check that passed, and
    // a guard that stays quiet when blind is indistinguishable from no guard.
    const failing = vi.fn(async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
    const results = await runWorkflowScheduleWatch(
      fakeSupabase([{ organization_id: 'org-1' }]),
      fakeKv(),
      ENV,
      NOW,
      failing,
    )
    expect(results.every((r) => r.status === 'unreadable')).toBe(true)
    expect(sendWorkflowScheduleAlert).toHaveBeenCalled()
  })

  it('alerts when the worker has no token to read the history with', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const results = await runWorkflowScheduleWatch(
      fakeSupabase([{ organization_id: 'org-1' }]),
      fakeKv(),
      { GITHUB_CODE_REPO: 'Try-Pennie/bidspoke' },
      NOW,
      fetchImpl,
    )
    expect(results.every((r) => r.status === 'unreadable')).toBe(true)
    expect(results[0].detail).toContain('GITHUB_TOKEN')
  })

  it('reports a confirmed absence of scheduled runs as its own state', async () => {
    const results = await runWorkflowScheduleWatch(
      fakeSupabase([{ organization_id: 'org-1' }]),
      fakeKv(),
      ENV,
      NOW,
      fetchAll(null),
    )
    expect(results.every((r) => r.status === 'never_ran')).toBe(true)
  })
})

describe('runWorkflowScheduleWatch: no Slack connection', () => {
  it('still reports the state rather than reading no orgs as healthy', async () => {
    // Finding no delivery target is not the same as finding nothing wrong, so the
    // verdict has to survive into the returned results and the logs even when
    // there is nobody to tell (L120).
    const results = await runWorkflowScheduleWatch(
      fakeSupabase([]),
      fakeKv(),
      ENV,
      NOW,
      fetchAll(iso(NOW - 40 * 3_600_000)),
    )
    expect(results.every((r) => r.status === 'stale')).toBe(true)
    expect(results.every((r) => r.alerted === false)).toBe(true)
  })
})
