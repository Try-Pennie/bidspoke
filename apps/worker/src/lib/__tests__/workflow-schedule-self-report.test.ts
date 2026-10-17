import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../slack', () => ({
  sendWorkflowScheduleAlert: vi.fn(async () => true),
}))

import { sendWorkflowScheduleAlert } from '../slack'
import {
  FAILING_STREAK,
  WATCHED_WORKFLOWS,
  classifySelfReported,
  evaluateSchedule,
  runWorkflowScheduleWatch,
  type ScheduleLookup,
} from '../workflow-schedule-watch'
import { alertRowListAnswer } from '../../__tests__/helpers/slack-alert-read'

/**
 * A Deploy Drift run that FOUND a stranded target and reported it to Slack is red
 * by design, and the watch must not report it a second time (#1761).
 *
 * On 2026-10-05 drift reported the same strand every hour all night, and the
 * schedule watch added "Deploy Drift keeps failing" about the same fact, because
 * two red runs in a row is its failing rule. The watch exists to backstop drift's
 * SILENCE: a drift run that delivered its own finding is not silent. So drift now
 * concludes a marker step only when every failure in the run was a finding it
 * reported (or held as a reminder not yet due), and the watch reads that step
 * before counting a failure.
 *
 * It must still speak when drift ITSELF is broken: a failed step other than the
 * gate, a run with no steps at all (the 2026-09-23 billing failure), a marker
 * that did not run, or a jobs read it could not complete (L42).
 */
const H = 3_600_000
const NOW = Date.parse('2026-10-05T12:00:00Z')
const DRIFT = WATCHED_WORKFLOWS.find((w) => w.file === 'deploy-drift.yml')!
const REPORTED_STEP = 'Every failure in this run was a finding reported to Slack'
const GATE = 'Fail the run if any target is stranded'
const access = { ok: true as const, repo: 'Try-Pennie/bidspoke', token: 'tok', tokenVar: 'GITHUB_ACTIONS_TOKEN' as const }

const lookup = (conclusions: (string | null)[], runIds?: (number | null)[]): Extract<ScheduleLookup, { ok: true }> => ({
  ok: true,
  lastRunIso: '2026-10-05T11:17:00Z',
  conclusions,
  runIds: runIds ?? conclusions.map((_, i) => 100 - i),
  manualPassIso: null,
})

const step = (name: string, conclusion: string) => ({ name, conclusion })

/** The jobs body of a drift run that found a strand and reported it (measured shape, run 37313686587). */
const reportedRun = () => ({
  jobs: [
    {
      conclusion: 'failure',
      steps: [
        step('Set up job', 'success'),
        step('Decide and alert', 'success'),
        step('Record the alert state for the next run', 'success'),
        step(REPORTED_STEP, 'success'),
        step(GATE, 'failure'),
      ],
    },
  ],
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** A fetch answering /actions/runs/{id}/jobs from `byId`, and counting the calls. */
const jobsFetch = (byId: Record<number, Response | (() => Response)>) =>
  vi.fn(async (url: string | URL) => {
    const id = Number(String(url).match(/\/actions\/runs\/(\d+)\/jobs/)?.[1])
    const answer = byId[id]
    if (answer === undefined) throw new Error(`unexpected request ${String(url)}`)
    return typeof answer === 'function' ? answer() : answer
  }) as unknown as typeof fetch & { mock: { calls: unknown[][] } }

describe('classifySelfReported: reading whether a failed run reported itself', () => {
  it('declares the marker and the gate for Deploy Drift', () => {
    expect(DRIFT.selfReport).toEqual({ reportedStep: REPORTED_STEP, failedSteps: [GATE] })
  })

  it('counts a run whose only failed step is the gate and whose marker passed', async () => {
    const f = jobsFetch({ 100: json(reportedRun()) })
    const r = await classifySelfReported(access, lookup(['failure', 'failure']), DRIFT.selfReport!, f)
    expect(r.reported[0]).toBe(true)
    expect(r.unreadable).toBeNull()
    expect(String(f.mock.calls[0][0])).toBe('https://api.github.com/repos/Try-Pennie/bidspoke/actions/runs/100/jobs?per_page=100')
  })

  it('stops at the first reported run, so a standing strand costs one request an hour', async () => {
    const f = jobsFetch({ 100: json(reportedRun()) })
    await classifySelfReported(access, lookup(['failure', 'failure', 'failure']), DRIFT.selfReport!, f)
    expect(f.mock.calls).toHaveLength(1)
  })

  it('reads at most as many failed runs as the failing streak needs', async () => {
    const notReported = () => json({ jobs: [{ conclusion: 'failure', steps: [step('Check out the live commit', 'failure')] }] })
    const f = jobsFetch({ 100: notReported, 99: notReported, 98: notReported })
    await classifySelfReported(access, lookup(['failure', 'failure', 'failure']), DRIFT.selfReport!, f)
    expect(f.mock.calls).toHaveLength(FAILING_STREAK)
  })

  it.each([
    ['the marker did not run', { jobs: [{ conclusion: 'failure', steps: [step(REPORTED_STEP, 'skipped'), step(GATE, 'failure')] }] }],
    [
      'another step failed, so a target went unchecked',
      {
        jobs: [
          {
            conclusion: 'failure',
            steps: [step('Check out the live commit', 'failure'), step(REPORTED_STEP, 'success'), step(GATE, 'failure')],
          },
        ],
      },
    ],
    ['the job never started (no steps, the billing failure shape)', { jobs: [{ conclusion: 'failure', steps: [] }] }],
    ['the job timed out', { jobs: [{ conclusion: 'timed_out', steps: [step(REPORTED_STEP, 'success'), step(GATE, 'failure')] }] }],
    [
      'a step timed out, even though the job concluded failure and the marker passed',
      { jobs: [{ conclusion: 'failure', steps: [step('Decide and alert', 'timed_out'), step(REPORTED_STEP, 'success'), step(GATE, 'failure')] }] },
    ],
    [
      'a step was cancelled',
      { jobs: [{ conclusion: 'failure', steps: [step('Decide and alert', 'cancelled'), step(REPORTED_STEP, 'success'), step(GATE, 'failure')] }] },
    ],
  ])('does not count it when %s', async (_label, body) => {
    const r = await classifySelfReported(access, lookup(['failure', 'failure']), DRIFT.selfReport!, jobsFetch({ 100: json(body), 99: json(body) }))
    expect(r.reported[0]).toBe(false)
    expect(r.unreadable).toBeNull()
  })

  it.each([
    ['GitHub refuses the read', () => json({ message: 'Resource not accessible by integration' }, 403)],
    ['the body is not JSON', () => new Response('<html>', { status: 200 })],
    ['the body has no jobs list', () => json({ message: 'x' })],
    ['the request throws', () => {
      throw new Error('network down')
    }],
  ])('fails toward speaking, and says why, when %s', async (_label, answer) => {
    const r = await classifySelfReported(access, lookup(['failure', 'failure']), DRIFT.selfReport!, jobsFetch({ 100: answer, 99: answer }))
    expect(r.reported[0]).toBe(false)
    expect(r.unreadable).not.toBeNull()
  })

  it('fails toward speaking when a failed run carries no id to read', async () => {
    const r = await classifySelfReported(access, lookup(['failure', 'failure'], [null, null]), DRIFT.selfReport!, jobsFetch({}))
    expect(r.reported).toEqual([false, false])
    expect(r.unreadable).toMatch(/no id/)
  })
})

describe('evaluateSchedule with self reports (#1761)', () => {
  it('is healthy when the newest failed run reported its own finding, and says why', () => {
    const v = evaluateSchedule(lookup(['failure', 'failure']), NOW, 4 * H, { reported: [true, false], unreadable: null })
    expect(v.status).toBe('healthy')
    expect(v.detail).toMatch(/reported .*Slack/)
  })

  it('does not claim every failed run reported when the newest did not, and names why it could not be read', () => {
    // The newest run's jobs could not be read (or it crashed with no marker), and
    // the run before it reported its strand. One unreported failure is under the
    // failing streak, so the verdict stays healthy, but the run log must not say
    // that both runs reported (L11).
    const v = evaluateSchedule(lookup(['failure', 'failure']), NOW, 4 * H, {
      reported: [false, true],
      unreadable: "GitHub returned 403 reading run 100's jobs",
    })
    expect(v.status).toBe('healthy')
    expect(v.detail).not.toMatch(/they found a problem/)
    expect(v.detail).toContain('the newest failed run did not report a finding of its own')
    expect(v.detail).toContain("could not be read: GitHub returned 403 reading run 100's jobs")
    expect(v.detail).toContain('the one before it reported its finding to Slack')
  })

  it('says the newest failed run did not report, without a reason, when its jobs were read and showed none', () => {
    const v = evaluateSchedule(lookup(['failure', 'failure']), NOW, 4 * H, { reported: [false, true], unreadable: null })
    expect(v.status).toBe('healthy')
    expect(v.detail).toContain('the newest failed run did not report a finding of its own')
    expect(v.detail).not.toContain('could not be read')
  })

  it('lets a reported run break a streak of older failures, so stale history cannot accuse', () => {
    const v = evaluateSchedule(lookup(['failure', 'failure', 'failure', 'failure']), NOW, 4 * H, {
      reported: [true, true, false, false],
      unreadable: null,
    })
    expect(v.status).toBe('healthy')
  })

  it('still fails when two runs in a row failed without reporting a finding of their own', () => {
    const v = evaluateSchedule(lookup(['failure', 'failure']), NOW, 4 * H, { reported: [false, false], unreadable: null })
    expect(v.status).toBe('failing')
    expect(v.detail).toBe('the last 2 scheduled runs failed without reporting a finding of their own')
  })

  it('still fails when whether they reported could not be read, saying that rather than that they did not', () => {
    const v = evaluateSchedule(lookup(['failure', 'failure']), NOW, 4 * H, {
      reported: [false, false],
      unreadable: 'GitHub returned 403',
    })
    expect(v.status).toBe('failing')
    expect(v.detail).toContain('could not be read: GitHub returned 403')
    expect(v.rateLimited).toBeUndefined()
  })

  it('behaves exactly as before when no self report was read', () => {
    expect(evaluateSchedule(lookup(['failure', 'failure']), NOW, 4 * H)).toEqual({
      status: 'failing',
      ageMs: NOW - Date.parse('2026-10-05T11:17:00Z'),
      detail: 'the last 2 scheduled runs failed',
    })
  })
})

const ENV = { GITHUB_ACTIONS_TOKEN: 'tok', GITHUB_CODE_REPO: 'Try-Pennie/bidspoke' }
const kv = () =>
  ({
    get: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
  }) as unknown as KVNamespace
const supabase = () =>
  ({
    from: () => ({ select: () => alertRowListAnswer({ data: [{ organization_id: 'org-1' }], error: null }) }),
  }) as unknown as SupabaseClient

/** The whole GitHub surface the watch reads: the repo, each workflow's runs, and drift's jobs. */
const github = (driftJobs: () => Response) =>
  vi.fn(async (url: string | URL) => {
    const href = String(url)
    if (/\/repos\/[^/]+\/[^/]+$/.test(href)) return json({})
    if (/\/actions\/runs\/\d+\/jobs/.test(href)) return driftJobs()
    const file = href.match(/workflows\/([^/]+)\/runs/)?.[1]
    if (file === 'deploy-drift.yml') {
      return json({
        workflow_runs: [
          { id: 100, created_at: '2026-10-05T11:17:00Z', conclusion: 'failure', event: 'schedule', head_branch: 'main' },
          { id: 99, created_at: '2026-10-05T10:17:00Z', conclusion: 'failure', event: 'schedule', head_branch: 'main' },
        ],
      })
    }
    if (file) {
      return json({ workflow_runs: [{ id: 1, created_at: '2026-10-05T08:00:00Z', conclusion: 'success', event: 'schedule' }] })
    }
    throw new Error(`unexpected request ${href}`)
  }) as unknown as typeof fetch

beforeEach(() => {
  vi.mocked(sendWorkflowScheduleAlert).mockClear()
  vi.mocked(sendWorkflowScheduleAlert).mockResolvedValue(true)
})

describe('runWorkflowScheduleWatch with a drift run that reported itself (#1761)', () => {
  it('does not post "Deploy Drift keeps failing" about a strand drift already reported', async () => {
    const results = await runWorkflowScheduleWatch(supabase(), kv(), ENV, NOW, github(() => json(reportedRun())))
    const drift = results.find((r) => r.file === 'deploy-drift.yml')!
    expect(drift.status).toBe('healthy')
    expect(drift.detail).toMatch(/reported/)
    expect(sendWorkflowScheduleAlert).not.toHaveBeenCalled()
  })

  it('still alerts when drift itself is broken, naming that the runs did not report a finding', async () => {
    const broken = () => json({ jobs: [{ conclusion: 'failure', steps: [step('Check out the live commit', 'failure')] }] })
    const results = await runWorkflowScheduleWatch(supabase(), kv(), ENV, NOW, github(broken))
    expect(results.find((r) => r.file === 'deploy-drift.yml')!.status).toBe('failing')
    expect(sendWorkflowScheduleAlert).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(sendWorkflowScheduleAlert).mock.calls[0][2]
    expect(payload.workflows[0].verdict.detail).toBe('the last 2 scheduled runs failed without reporting a finding of their own')
  })

  it('still alerts when the jobs cannot be read, rather than taking silence as a report (L42)', async () => {
    const results = await runWorkflowScheduleWatch(supabase(), kv(), ENV, NOW, github(() => json({ message: 'no' }, 403)))
    const drift = results.find((r) => r.file === 'deploy-drift.yml')!
    expect(drift.status).toBe('failing')
    expect(drift.detail).toContain('could not be read')
    expect(sendWorkflowScheduleAlert).toHaveBeenCalledTimes(1)
  })

  it('asks for no jobs at all while drift is passing', async () => {
    const f = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (/\/repos\/[^/]+\/[^/]+$/.test(href)) return json({})
      if (/\/jobs/.test(href)) throw new Error('jobs were read for a passing workflow')
      return json({ workflow_runs: [{ id: 1, created_at: '2026-10-05T11:17:00Z', conclusion: 'success', event: 'schedule' }] })
    }) as unknown as typeof fetch
    const results = await runWorkflowScheduleWatch(supabase(), kv(), ENV, NOW, f)
    expect(results.every((r) => r.status === 'healthy')).toBe(true)
  })
})
