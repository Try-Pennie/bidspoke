import { describe, expect, it, vi } from 'vitest'
import {
  DISPATCH_REF,
  DRIVE_TICK_MS,
  decideDue,
  dispatchWorkflow,
  runWorkflowDispatchDriver,
} from '../workflow-dispatch-driver'
import { DRIVER_MARKER, WATCHED_WORKFLOWS } from '../workflow-schedule-watch'

/**
 * GitHub stopped delivering this repository's scheduled events reliably on
 * 2026-08-26: scheduled runs fell from about 24 a day to 3, while push and
 * pull_request runs on the same repository kept firing normally. Actions itself
 * was healthy, the workflows were enabled, and every run that did fire passed.
 * Only the cron delivery was dropping.
 *
 * So the worker drives these workflows from its own hourly cron, which is
 * reliable, using the on-demand dispatch that demonstrably still works.
 */

const access = {
  ok: true as const,
  repo: 'Try-Pennie/bidspoke',
  token: 'tok',
  tokenVar: 'GITHUB_ACTIONS_TOKEN' as const,
}

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-08-29T14:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('decideDue: when the worker should step in', () => {
  it('dispatches when the last qualifying run is older than the cadence', () => {
    const lookup = { ok: true as const, lastRunIso: ago(5 * HOUR), conclusions: ['success'], runIds: [], manualPassIso: null }
    expect(decideDue(lookup, NOW, HOUR).act).toBe('dispatch')
  })

  it('waits when a qualifying run happened within the cadence, so GitHub recovering costs us nothing', () => {
    // The driver is a backstop, not a replacement. If GitHub starts delivering
    // the cron again, this must go quiet on its own rather than doubling every
    // run for ever.
    const lookup = { ok: true as const, lastRunIso: ago(10 * 60 * 1000), conclusions: ['success'], runIds: [], manualPassIso: null }
    expect(decideDue(lookup, NOW, HOUR).act).toBe('wait')
  })

  it('dispatches when GitHub has no qualifying run on record at all', () => {
    const lookup = { ok: true as const, lastRunIso: null, conclusions: [], runIds: [], manualPassIso: null }
    expect(decideDue(lookup, NOW, HOUR).act).toBe('dispatch')
  })

  it('does NOT dispatch when the lookup failed, because nothing was measured', () => {
    // A failed read is not evidence the workflow is behind. Acting on it would
    // dispatch on every cycle of an outage that has nothing to do with the
    // schedule, and the watch already reports an unreadable lookup itself.
    const lookup = { ok: false as const, reason: 'GitHub returned 500' }
    const decision = decideDue(lookup, NOW, HOUR)
    expect(decision.act).toBe('unknown')
    expect(decision.why).toContain('500')
  })

  it('does NOT dispatch when the timestamp cannot be read', () => {
    // Date.parse yields NaN here, and NaN compares false against every
    // threshold, so an unguarded comparison would silently land on "wait": the
    // one answer this must never give without having measured it (L50).
    const lookup = { ok: true as const, lastRunIso: 'not a date', conclusions: [], runIds: [], manualPassIso: null }
    expect(decideDue(lookup, NOW, HOUR).act).toBe('unknown')
  })
})

describe('dispatchWorkflow: what it actually asks GitHub to do', () => {
  const ok204 = () => vi.fn().mockResolvedValue(new Response(null, { status: 204 }))

  it('posts a dispatch naming the branch and stamping the driver marker', async () => {
    const fetchMock = ok204()
    const result = await dispatchWorkflow(access, 'deploy-drift.yml', fetchMock)
    expect(result.ok).toBe(true)

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(
      'https://api.github.com/repos/Try-Pennie/bidspoke/actions/workflows/deploy-drift.yml/dispatches',
    )
    expect((init as RequestInit).method).toBe('POST')
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.ref).toBe(DISPATCH_REF)
    expect(
      body.inputs.driver,
      'without the marker the watch cannot tell this run from a person pressing the button',
    ).toBe(DRIVER_MARKER)
  })

  it('names a permission refusal as its own cause, because that is the one a person must fix', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('no', { status: 403 }))
    const result = await dispatchWorkflow(access, 'deploy-drift.yml', fetchMock)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('403')
    expect(result.ok === false && result.reason).toContain('GITHUB_ACTIONS_TOKEN')
  })

  it('reports a used up request allowance as a rate limit, not a missing permission (#1365)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'API rate limit exceeded for user ID 1234567.' }), {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 600) },
      }),
    )
    const result = await dispatchWorkflow(access, 'deploy-drift.yml', fetchMock)
    expect(result).toMatchObject({ ok: false, rateLimited: true })
    expect(result.ok === false && result.reason).toContain('rate limit')
    expect(result.ok === false && result.reason).not.toContain('needs Actions')
  })

  it('reports a 422 as its own cause, because that means the workflow takes no dispatch', async () => {
    // GitHub answers 422 when the workflow has no `workflow_dispatch` trigger on
    // the default branch, which is a different repair from a token problem.
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 422 }))
    const result = await dispatchWorkflow(access, 'deploy-drift.yml', fetchMock)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('422')
  })

  it('reports a thrown network error as a failure rather than swallowing it', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT'))
    const result = await dispatchWorkflow(access, 'deploy-drift.yml', fetchMock)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('ETIMEDOUT')
  })

  it('marks a GitHub 5xx and a dropped connection as transient, and nothing else (#1751)', async () => {
    // A 500 from GitHub's own service cleared on the next tick on 2026-10-04 and
    // paged anyway. Only GitHub's side failing is transient: a refusal or a
    // missing workflow needs somebody to act, so it must not be held back.
    const answer = (status: number) => vi.fn().mockResolvedValue(new Response('x', { status }))
    for (const status of [500, 502, 503]) {
      const r = await dispatchWorkflow(access, 'deploy-drift.yml', answer(status))
      expect(r, `${status} should be transient`).toMatchObject({ ok: false, transient: true })
    }
    const dropped = await dispatchWorkflow(access, 'deploy-drift.yml', vi.fn().mockRejectedValue(new Error('reset')))
    expect(dropped).toMatchObject({ ok: false, transient: true })
    for (const status of [200, 401, 403, 404, 422]) {
      const r = await dispatchWorkflow(access, 'deploy-drift.yml', answer(status))
      expect(r.ok === false && r.transient, `${status} must not be transient`).toBeFalsy()
    }
  })

  it('treats a 200 as a failure, because a real dispatch answers 204', async () => {
    // Anything other than the documented 204 means GitHub did not do what was
    // asked, and reading it as success would report a run that never started.
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    expect((await dispatchWorkflow(access, 'deploy-drift.yml', fetchMock)).ok).toBe(false)
  })
})

describe('the registry carries a drive threshold for every workflow', () => {
  it('gives each watched workflow a threshold with real headroom below its alert window', () => {
    // Two different numbers. `driveAfterMs` is the age at which the worker steps
    // in; `staleMs` is the age at which the watch complains. The first must sit
    // comfortably below the second, or the driver only acts once the alert has
    // already fired and the backstop is decorative.
    expect(WATCHED_WORKFLOWS.length).toBeGreaterThan(0)
    for (const w of WATCHED_WORKFLOWS) {
      expect(w.driveAfterMs, `${w.file} has no drive threshold`).toBeGreaterThan(0)
      expect(
        w.driveAfterMs,
        `${w.file} would not be driven until its alert had already fired`,
      ).toBeLessThan(w.staleMs)
      // Room for at least two retries before anybody is paged. The driver runs
      // on the worker's 15 minute cron (#1368), so a failed dispatch is retried
      // one tick later: the headroom is measured in ticks, not in drive thresholds.
      expect(
        w.staleMs - w.driveAfterMs,
        `${w.file} leaves no room for a failed dispatch to be retried before the alert fires`,
      ).toBeGreaterThanOrEqual(2 * DRIVE_TICK_MS)
    }
  })
})

describe('runWorkflowDispatchDriver: failing loud', () => {
  const env = { GITHUB_ACTIONS_TOKEN: 'tok', GITHUB_CODE_REPO: 'Try-Pennie/bidspoke' }

  /** Runs list answer for a workflow last driven `ms` ago. */
  const runsBody = (ms: number) =>
    JSON.stringify({
      workflow_runs: [
        { created_at: ago(ms), conclusion: 'success', event: 'workflow_dispatch', display_title: `x (${DRIVER_MARKER})` },
      ],
    })

  /** A fetch that answers the repo check, the runs lookups, and the dispatches. */
  const wire = (opts: { lastRunAgoMs: number; dispatchStatus: number }) =>
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/dispatches')) return new Response(null, { status: opts.dispatchStatus })
      if (url.includes('/actions/workflows/')) return new Response(runsBody(opts.lastRunAgoMs), { status: 200 })
      return new Response('{}', { status: 200 })
    })

  it('dispatches every overdue workflow and reports it', async () => {
    const fetchMock = wire({ lastRunAgoMs: 30 * HOUR, dispatchStatus: 204 })
    const results = await runWorkflowDispatchDriver(env, NOW, fetchMock)
    expect(results.length).toBe(WATCHED_WORKFLOWS.length)
    expect(results.every((r) => r.outcome === 'dispatched')).toBe(true)
  })

  it('reports a refused dispatch as failed rather than reporting it as done', async () => {
    const fetchMock = wire({ lastRunAgoMs: 30 * HOUR, dispatchStatus: 403 })
    const results = await runWorkflowDispatchDriver(env, NOW, fetchMock)
    expect(results.every((r) => r.outcome === 'failed')).toBe(true)
    expect(results[0].reason).toContain('403')
  })

  it('dispatches nothing when every workflow ran recently', async () => {
    const fetchMock = wire({ lastRunAgoMs: 60 * 1000, dispatchStatus: 204 })
    const results = await runWorkflowDispatchDriver(env, NOW, fetchMock)
    expect(results.every((r) => r.outcome === 'not_due')).toBe(true)
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/dispatches'))).toBe(false)
  })

  it('carries on to the next workflow when one lookup cannot be read', async () => {
    // L73: independent steps sharing one handler each need their own failure
    // boundary. Without one, the first bad lookup leaves every workflow after it
    // undriven, which looks exactly like a healthy run.
    //
    // A network error is caught by the lookup itself and becomes an unreadable
    // answer, so the outcome here is `unknown` rather than `failed`: nothing was
    // measured, so no dispatch can be justified, and that is a different fact
    // from a dispatch GitHub refused.
    let first = true
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/dispatches')) return new Response(null, { status: 204 })
      if (url.includes('/actions/workflows/')) {
        if (first) {
          first = false
          throw new Error('boom')
        }
        return new Response(runsBody(30 * HOUR), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    const results = await runWorkflowDispatchDriver(env, NOW, fetchMock)
    expect(results.length).toBe(WATCHED_WORKFLOWS.length)
    expect(results[0].outcome).toBe('unknown')
    expect(results[0].reason).toContain('boom')
    expect(
      results.slice(1).every((r) => r.outcome === 'dispatched'),
      'one unreadable lookup stopped the workflows after it being driven',
    ).toBe(true)
  })

  it('catches a throw that escapes a callee entirely, rather than losing the whole run', async () => {
    // The driver's own try/catch is a backstop for a callee that throws PAST its
    // own boundary. That is reachable today: `lookupLastScheduledRun` reads
    // `response.status` outside the try that wraps the fetch, so a fetch which
    // resolves to something that is not a Response throws straight through it.
    // Without this test that catch would be untestable, and untestable defensive
    // code is indistinguishable from dead code (L29).
    let first = true
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/dispatches')) return new Response(null, { status: 204 })
      if (url.includes('/actions/workflows/') && first) {
        first = false
        return null as unknown as Response
      }
      return new Response(runsBody(30 * HOUR), { status: 200 })
    })
    const results = await runWorkflowDispatchDriver(env, NOW, fetchMock)
    expect(results[0].outcome).toBe('failed')
    expect(results[0].reason).toContain('threw')
    expect(results.slice(1).every((r) => r.outcome === 'dispatched')).toBe(true)
  })

  it('reports a missing credential once, as configuration, and dispatches nothing', async () => {
    const fetchMock = vi.fn()
    const results = await runWorkflowDispatchDriver({ GITHUB_CODE_REPO: 'x/y' }, NOW, fetchMock)
    expect(results.every((r) => r.outcome === 'unconfigured')).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
