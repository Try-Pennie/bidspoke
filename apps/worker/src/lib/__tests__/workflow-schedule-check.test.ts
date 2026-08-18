import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../slack', () => ({
  sendWorkflowScheduleAlert: vi.fn(async () => true),
}))

import { sendWorkflowScheduleAlert } from '../slack'
import { runWorkflowScheduleWatch, WATCHED_WORKFLOWS } from '../workflow-schedule-watch'

/**
 * The orchestration half of the scheduled-workflow dead-man's-switch (#805):
 * which states reach Slack, how often, in how many messages, and which stay quiet.
 *
 * The decision itself is covered next door. What is covered here is the part
 * that can go wrong without any decision being wrong: alerting on every run of
 * an hourly check would make a single dark workflow produce 24 messages a day
 * and train everyone to ignore it (LESSONS L36), while staying quiet on a
 * lookup that could not be completed would leave a guard that is
 * indistinguishable from no guard at all (L98).
 *
 * And one message per WATCHED WORKFLOW is the same mistake in a smaller shape
 * (#843): every cause that is global rather than per-workflow (an unusable
 * credential, a GitHub outage, a rate limit) hits all of them at once, so the
 * registry length decided how many identical messages one fact produced.
 */
const NOW = Date.parse('2026-08-17T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

const ENV = { GITHUB_ACTIONS_TOKEN: 'tok', GITHUB_CODE_REPO: 'Try-Pennie/bidspoke' }

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

/**
 * A fetch that lets the repository read succeed and answers every workflow with
 * the same last-run timestamp. `perFile` overrides the answer for one file.
 */
const fetchAll = (
  lastRunIso: string | null,
  opts: { conclusion?: string | null; perFile?: Record<string, string | null> } = {},
) =>
  vi.fn(async (url: string | URL) => {
    const href = String(url)
    // The repository probe, which classifies a credential problem once per run
    // instead of once per workflow.
    if (/\/repos\/[^/]+\/[^/]+$/.test(href)) return new Response('{}', { status: 200 })

    const file = href.match(/workflows\/([^/]+)\/runs/)?.[1] ?? ''
    const stamp = opts.perFile && file in opts.perFile ? opts.perFile[file] : lastRunIso
    const conclusion = opts.conclusion === undefined ? 'success' : opts.conclusion
    return new Response(
      JSON.stringify({
        workflow_runs:
          stamp === null
            ? []
            : [
                { created_at: stamp, conclusion },
                { created_at: stamp, conclusion },
              ],
      }),
      { status: 200 },
    )
  }) as unknown as typeof fetch

/** How many Slack messages were posted, across all orgs. */
const messages = () => vi.mocked(sendWorkflowScheduleAlert).mock.calls.length

beforeEach(() => {
  vi.mocked(sendWorkflowScheduleAlert).mockClear()
  vi.mocked(sendWorkflowScheduleAlert).mockResolvedValue(true)
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

describe('runWorkflowScheduleWatch: one message per run, not one per workflow (#843)', () => {
  it('reports every dark workflow in a single message to each org', async () => {
    const results = await runWorkflowScheduleWatch(
      fakeSupabase([{ organization_id: 'org-1' }, { organization_id: 'org-2' }]),
      fakeKv(),
      ENV,
      NOW,
      // Older than every window in the registry.
      fetchAll(iso(NOW - 40 * 3_600_000)),
    )
    expect(results.every((r) => r.status === 'stale')).toBe(true)
    // Two orgs, one message each, however long the registry grows.
    expect(messages()).toBe(2)
    const payload = vi.mocked(sendWorkflowScheduleAlert).mock.calls[0][2]
    expect(payload.workflows.length).toBe(WATCHED_WORKFLOWS.length)
  })

  it('reports a credential problem once, as one fact about configuration', async () => {
    // The live #842 failure: the borrowed token cannot see this repository, so
    // every workflow is unreadable for the same reason and the registry length
    // was deciding how many identical messages that produced.
    const denied = vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    const results = await runWorkflowScheduleWatch(
      fakeSupabase([{ organization_id: 'org-1' }]),
      fakeKv(),
      ENV,
      NOW,
      denied,
    )
    expect(messages()).toBe(1)
    const payload = vi.mocked(sendWorkflowScheduleAlert).mock.calls[0][2]
    expect(payload.config, 'a configuration failure was reported as per-workflow news').not.toBeNull()
    expect(results.every((r) => r.status === 'unreadable')).toBe(true)
  })

  it('does not ask about each workflow once it knows it cannot see the repository', async () => {
    // Not a cost argument: asking per file produces N indistinguishable 404s, and
    // the per-file 404 is what "this workflow is gone" is decided from, so the
    // repository probe has to come first for either verdict to mean anything.
    const denied = vi.fn(async () => new Response('nope', { status: 404 }))
    await runWorkflowScheduleWatch(
      fakeSupabase([{ organization_id: 'org-1' }]),
      fakeKv(),
      ENV,
      NOW,
      denied as unknown as typeof fetch,
    )
    expect(denied).toHaveBeenCalledTimes(1)
  })
})

describe('runWorkflowScheduleWatch: a workflow that has gone dark', () => {
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

  it('speaks immediately when a DIFFERENT workflow goes dark inside the cooldown', async () => {
    // The trap in aggregating: a cooldown keyed on the group rather than on what
    // the group currently says would let the first problem's silence swallow the
    // second problem entirely, which is two independent checks sharing one status
    // field (L53).
    const kv = fakeKv()
    const supabase = fakeSupabase([{ organization_id: 'org-1' }])
    const fresh = iso(NOW - 60_000)
    const dark = iso(NOW - 40 * 3_600_000)
    const [first, second] = WATCHED_WORKFLOWS.map((w) => w.file)

    await runWorkflowScheduleWatch(supabase, kv, ENV, NOW, fetchAll(fresh, { perFile: { [first]: dark } }))
    expect(messages()).toBe(1)
    vi.mocked(sendWorkflowScheduleAlert).mockClear()

    const results = await runWorkflowScheduleWatch(
      supabase,
      kv,
      ENV,
      NOW + 3_600_000,
      fetchAll(fresh, { perFile: { [first]: dark, [second]: dark } }),
    )
    expect(messages(), 'the second workflow going dark was swallowed by the first one\'s cooldown').toBe(1)
    expect(results.filter((r) => r.status === 'stale').length).toBe(2)
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
    expect([...kv.store.keys()]).toEqual([])
  })
})

describe('runWorkflowScheduleWatch: a workflow that fires and fails (#844)', () => {
  it('alerts on a persistent failure rather than calling it healthy', async () => {
    const results = await runWorkflowScheduleWatch(
      fakeSupabase([{ organization_id: 'org-1' }]),
      fakeKv(),
      ENV,
      NOW,
      fetchAll(iso(NOW - 60_000), { conclusion: 'failure' }),
    )
    expect(results.every((r) => r.status === 'failing')).toBe(true)
    expect(messages()).toBe(1)
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

  it('alerts when the worker has no token to read the history with, naming both secrets', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const results = await runWorkflowScheduleWatch(
      fakeSupabase([{ organization_id: 'org-1' }]),
      fakeKv(),
      { GITHUB_CODE_REPO: 'Try-Pennie/bidspoke' },
      NOW,
      fetchImpl,
    )
    expect(results.every((r) => r.status === 'unreadable')).toBe(true)
    expect(results[0].detail).toContain('GITHUB_ACTIONS_TOKEN')
    expect(fetchImpl, 'it called GitHub with no credential').not.toHaveBeenCalled()
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

describe('one failure must not silence the rest (L71)', () => {
  it('keeps the other workflows\' verdicts when one lookup throws', async () => {
    // The watchdog must not share the abort-on-error behaviour of the work it
    // watches. Without a boundary per workflow, one thrown lookup leaves every
    // workflow after it unchecked, which looks exactly like a healthy system.
    const [first] = WATCHED_WORKFLOWS.map((w) => w.file)
    const flaky = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (/\/repos\/[^/]+\/[^/]+$/.test(href)) return new Response('{}', { status: 200 })
      if (href.includes(first)) throw new Error('lookup exploded')
      return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const results = await runWorkflowScheduleWatch(
      fakeSupabase([{ organization_id: 'org-1' }]),
      fakeKv(),
      ENV,
      NOW,
      flaky,
    )
    expect(results.length).toBe(WATCHED_WORKFLOWS.length)
    expect(results.some((r) => r.status === 'unreadable' && r.detail.includes('exploded'))).toBe(true)
    // And the rest still reached their real verdict.
    expect(results.some((r) => r.status === 'never_ran')).toBe(true)
  })

  it('keeps the verdicts when the alert itself throws', async () => {
    vi.mocked(sendWorkflowScheduleAlert).mockRejectedValueOnce(new Error('slack exploded'))
    const results = await runWorkflowScheduleWatch(
      fakeSupabase([{ organization_id: 'org-1' }]),
      fakeKv(),
      ENV,
      NOW,
      fetchAll(iso(NOW - 40 * 3_600_000)),
    )
    // The verdict is what the logs and the return value are for, so it must not be
    // destroyed by a failure to deliver it.
    expect(results.every((r) => r.status === 'stale')).toBe(true)
    expect(results.every((r) => r.alerted === false)).toBe(true)
  })

  it('speaks anyway when the cooldown store is unreadable', async () => {
    // A protective control fails towards speaking (L42). An unreadable cooldown
    // is not evidence anyone has been told, and a duplicate message is a far
    // cheaper mistake than six hours of silence about a dark deploy check.
    const kv = {
      get: vi.fn(async () => {
        throw new Error('kv down')
      }),
      put: vi.fn(async () => undefined),
    } as unknown as KVNamespace
    const results = await runWorkflowScheduleWatch(
      fakeSupabase([{ organization_id: 'org-1' }]),
      kv,
      ENV,
      NOW,
      fetchAll(iso(NOW - 40 * 3_600_000)),
    )
    expect(results.length).toBe(WATCHED_WORKFLOWS.length)
    expect(results.every((r) => r.status === 'stale'), 'a broken cooldown store erased the real verdict').toBe(true)
    expect(sendWorkflowScheduleAlert).toHaveBeenCalled()
  })
})
