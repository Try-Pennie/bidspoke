import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAndReportDispatch } from '../workflow-dispatch-run'
import { WATCHED_WORKFLOWS } from '../workflow-schedule-watch'
import { sendWorkflowDispatchAlert } from '../slack'

vi.mock('../slack', () => ({ sendWorkflowDispatchAlert: vi.fn() }))

/**
 * The orchestration around the dispatch driver: read the Slack orgs, log what
 * the driver did, and deliver a failure to each org.
 *
 * This lives in its own module rather than inline in the cron handler because
 * the interesting behaviour here is what happens when things go WRONG, and none
 * of it is reachable from a test while it sits inside `scheduled()`.
 */

const NOW = Date.parse('2026-08-29T14:00:00Z')
const env = { GITHUB_ACTIONS_TOKEN: 'tok', GITHUB_CODE_REPO: 'Try-Pennie/bidspoke' }

/** Supabase double whose connections read either succeeds or fails. */
function makeSupabase(result: { data: unknown; error: unknown }) {
  const chain: unknown = new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'eq') return () => Promise.resolve(result)
        return () => chain
      },
    },
  )
  return { from: () => chain } as never
}

const orgsOk = makeSupabase({ data: [{ organization_id: 'org-1' }, { organization_id: 'org-2' }], error: null })

/** A fetch that drives every workflow and answers the dispatch with `status`. */
const wire = (dispatchStatus: number) =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/dispatches')) return new Response(null, { status: dispatchStatus })
    // Old enough that every workflow is overdue.
    return new Response(
      JSON.stringify({
        workflow_runs: [{ created_at: '2026-08-01T00:00:00Z', conclusion: 'success', event: 'schedule' }],
      }),
      { status: 200 },
    )
  }) as unknown as typeof fetch

beforeEach(() => {
  vi.mocked(sendWorkflowDispatchAlert).mockReset()
  vi.mocked(sendWorkflowDispatchAlert).mockResolvedValue(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * A KV double backed by a Map. `failGet` makes every read throw, which is how a
 * KV outage arrives. `puts` records every write with its options so a test can
 * see the cooldown's lifetime.
 */
function makeKv(opts: { failGet?: boolean } = {}) {
  const store = new Map<string, string>()
  const puts: { key: string; ttl: number | undefined }[] = []
  return Object.assign(
    {
      get: vi.fn(async (key: string) => {
        if (opts.failGet) throw new Error('kv unavailable')
        return store.get(key) ?? null
      }),
      put: vi.fn(async (key: string, value: string, o?: { expirationTtl?: number }) => {
        store.set(key, value)
        puts.push({ key, ttl: o?.expirationTtl })
      }),
    },
    { puts },
  ) as unknown as KVNamespace & { puts: { key: string; ttl: number | undefined }[] }
}

const errors = () => vi.mocked(console.error).mock.calls.map((c) => c.join(' ')).join('\n')

describe('runAndReportDispatch', () => {
  it('alerts every org when a dispatch was refused', async () => {
    const results = await runAndReportDispatch(orgsOk, env, makeKv(), NOW, wire(403))
    expect(results.every((r) => r.outcome === 'failed')).toBe(true)
    expect(vi.mocked(sendWorkflowDispatchAlert).mock.calls.map((c) => c[1])).toEqual(['org-1', 'org-2'])
  })

  it('alerts nobody when every dispatch worked', async () => {
    await runAndReportDispatch(orgsOk, env, makeKv(), NOW, wire(204))
    expect(sendWorkflowDispatchAlert).not.toHaveBeenCalled()
  })

  it('logs a summary on every run, including a clean one', async () => {
    // A driver that silently stopped driving is the failure this whole change
    // exists to prevent, and only a positive reading tells it from a healthy run
    // (L98, L106).
    await runAndReportDispatch(orgsOk, env, makeKv(), NOW, wire(204))
    const logged = vi.mocked(console.log).mock.calls.map((c) => c.join(' ')).join('\n')
    for (const w of WATCHED_WORKFLOWS) expect(logged).toContain(w.file)
    expect(logged).toContain('dispatched')
  })

  it('reports a failed connections read instead of reading it as nobody to tell', async () => {
    // The failure the lessons scan caught. A failed read yields no orgs, the
    // alert loop runs zero times, and a refused dispatch goes unreported: a
    // transient database error and a healthy system would otherwise produce the
    // identical outcome, with nothing to tell them apart (L10, L11).
    const broken = makeSupabase({ data: null, error: { message: 'connection reset' } })
    const results = await runAndReportDispatch(broken, env, makeKv(), NOW, wire(403))
    expect(errors(), 'the failed read was silent, so nobody can tell it from having no orgs').toContain(
      'connection reset',
    )
    expect(
      results.every((r) => r.outcome === 'failed'),
      'the verdict was destroyed by the delivery problem',
    ).toBe(true)
  })

  it('keeps alerting the remaining orgs when one org delivery throws', async () => {
    // Failing to DELIVER a verdict to one org must not cost the others theirs
    // (L73).
    vi.mocked(sendWorkflowDispatchAlert)
      .mockRejectedValueOnce(new Error('slack down'))
      .mockResolvedValue(true)
    await runAndReportDispatch(orgsOk, env, makeKv(), NOW, wire(403))
    expect(vi.mocked(sendWorkflowDispatchAlert).mock.calls.length).toBe(2)
    expect(errors()).toContain('slack down')
  })

  it('still returns the driver verdict when the driver itself found nothing to do', async () => {
    const recent = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/dispatches')) return new Response(null, { status: 204 })
      return new Response(
        JSON.stringify({
          workflow_runs: [{ created_at: new Date(NOW - 60_000).toISOString(), conclusion: 'success', event: 'schedule' }],
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const results = await runAndReportDispatch(orgsOk, env, makeKv(), NOW, recent)
    expect(results.every((r) => r.outcome === 'not_due')).toBe(true)
    expect(sendWorkflowDispatchAlert).not.toHaveBeenCalled()
  })
})

describe('runAndReportDispatch: at most one alert an hour for the same failure (#1368)', () => {
  // The driver runs every 15 minutes so a refused read is retried within the
  // hour. A failure that persists would then page four times an hour, which is
  // the noise that teaches people to skip alerts (L36).

  it('alerts once for a failure that repeats within the hour', async () => {
    const kv = makeKv()
    await runAndReportDispatch(orgsOk, env, kv, NOW, wire(403))
    await runAndReportDispatch(orgsOk, env, kv, NOW + 15 * 60_000, wire(403))
    expect(vi.mocked(sendWorkflowDispatchAlert).mock.calls.length, 'two orgs, once each').toBe(2)
    expect(kv.puts.map((p) => p.ttl)).toEqual([3600])
  })

  it('alerts again straight away when the set of failures changes', async () => {
    const kv = makeKv()
    await runAndReportDispatch(orgsOk, env, kv, NOW, wire(403))
    // Now unconfigured rather than refused: a different fault, so a different repair.
    await runAndReportDispatch(orgsOk, { GITHUB_CODE_REPO: 'Try-Pennie/bidspoke' }, kv, NOW + 15 * 60_000, wire(403))
    expect(vi.mocked(sendWorkflowDispatchAlert).mock.calls.length).toBe(4)
  })

  it('still alerts when the cooldown cannot be read, because silence is the worse failure (L42)', async () => {
    const kv = makeKv({ failGet: true })
    await runAndReportDispatch(orgsOk, env, kv, NOW, wire(403))
    await runAndReportDispatch(orgsOk, env, kv, NOW + 15 * 60_000, wire(403))
    expect(vi.mocked(sendWorkflowDispatchAlert).mock.calls.length).toBe(4)
    expect(errors()).toContain('kv unavailable')
  })

  it('does not arm the cooldown when no alert was delivered, so the next run tries again', async () => {
    vi.mocked(sendWorkflowDispatchAlert).mockResolvedValue(false)
    const kv = makeKv()
    await runAndReportDispatch(orgsOk, env, kv, NOW, wire(403))
    expect(kv.puts).toEqual([])
    vi.mocked(sendWorkflowDispatchAlert).mockResolvedValue(true)
    await runAndReportDispatch(orgsOk, env, kv, NOW + 15 * 60_000, wire(403))
    expect(vi.mocked(sendWorkflowDispatchAlert).mock.calls.length).toBe(4)
  })
})

describe('runAndReportDispatch: a rate limited read is retried on the next tick (#1368)', () => {
  it('dispatches a quarter hour later once GitHub answers again', async () => {
    const limited = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'API rate limit exceeded for user ID 1.' }), {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 600) },
      }),
    ) as unknown as typeof fetch
    const first = await runAndReportDispatch(orgsOk, env, makeKv(), NOW, limited)
    expect(first.every((r) => r.outcome === 'unknown')).toBe(true)
    const second = await runAndReportDispatch(orgsOk, env, makeKv(), NOW + 15 * 60_000, wire(204))
    expect(second.every((r) => r.outcome === 'dispatched')).toBe(true)
  })
})
