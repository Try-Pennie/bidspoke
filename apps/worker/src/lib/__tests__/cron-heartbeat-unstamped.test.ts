import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../slack', () => ({
  sendCronHeartbeatAlert: vi.fn(async () => true),
}))

import { sendCronHeartbeatAlert } from '../slack'
import { runHeartbeatChecks, heartbeatKey, completedKey, firstSeenKey, CRON_JOBS, cronJob } from '../cron-heartbeat'
import { readCondition, BACKOFF_STEPS_SECONDS } from '../alert-backoff'

/**
 * A job that IS running but is not stamping its heartbeat (#1332).
 *
 * PR #1324 registered the archive's 13 month expiry in CRON_JOBS and never added
 * the writeHeartbeat call. The job ran and finished at 13:00 UTC on two
 * consecutive days, recorded in job_runs with its outcome, while this check
 * alerted every six hours that it had never run and told the reader to go and
 * check cron triggers that were correct. An independent record of the same fact
 * was in the database the whole time and nothing read it (L70, L345).
 */
const NOW = Date.parse('2026-09-13T18:00:00.000Z')
const H = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()
const JOB = 'execution-archive-expiry'

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  const ttls = new Map<string, number | undefined>()
  return {
    store,
    ttls,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string, opts?: { expirationTtl?: number }) => {
      store.set(k, v)
      ttls.set(k, opts?.expirationTtl)
    }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  } as unknown as KVNamespace & { store: Map<string, string>; ttls: Map<string, number | undefined> }
}

/**
 * Answers the two reads this check makes. `runs` maps a job id to the ISO
 * finish time of its newest completed run; a job absent from the map has no
 * evidence either way, which is the common case and must not be read as proof.
 */
function fakeSupabase(runs: Record<string, string | null>, opts: { runsError?: boolean } = {}): SupabaseClient {
  return {
    from: (table: string) => {
      if (table === 'job_runs') {
        const chain = {
          select: () => chain,
          eq: (_col: string, job: string) => {
            chain._job = job
            return chain
          },
          not: () => chain,
          order: () => chain,
          limit: () => {
            if (opts.runsError) return Promise.resolve({ data: null, error: { message: 'read failed' } })
            const finished = runs[chain._job as string]
            return Promise.resolve({
              data: finished ? [{ finished_at: finished }] : [],
              error: null,
            })
          },
          _job: '' as string,
        }
        return chain
      }
      return { select: () => ({ eq: () => Promise.resolve({ data: [{ organization_id: 'org-1' }], error: null }) }) }
    },
  } as unknown as SupabaseClient
}

/** Every other job fresh, so only the job under test can be judged. */
function allFreshExcept(id: string, nowMs: number): Record<string, string> {
  // Healthy means started AND finished: a minute job is judged on finished runs
  // (#2057), so one that only ever starts is, correctly, a job that never finishes.
  return Object.fromEntries(
    CRON_JOBS.filter((j) => j.id !== id).flatMap((j) => [
      [heartbeatKey(j.id), iso(nowMs - 1)],
      [completedKey(j.id), iso(nowMs - 1)],
    ]),
  )
}

/**
 * Re-stamp every other job at the moment about to be checked.
 *
 * The two-hour jobs go stale three hours after their stamp, so a fixture frozen
 * at the first tick would have half the registry alerting by the third, and the
 * call counts below would be measuring the fixture (L130).
 */
function refreshOthers(kv: { store: Map<string, string> }, id: string, nowMs: number): void {
  for (const [k, v] of Object.entries(allFreshExcept(id, nowMs))) kv.store.set(k, v)
}

beforeEach(() => {
  vi.mocked(sendCronHeartbeatAlert).mockClear()
})

describe('a registered job with no heartbeat stamp', () => {
  it('is reported as unstamped, not dark, when job_runs shows it finished recently', async () => {
    const kv = fakeKv({
      ...allFreshExcept(JOB, NOW),
      // Seen two days ago and never stamped: the exact 2026-09-11 state.
      [firstSeenKey(JOB)]: iso(NOW - 48 * H),
    })
    const supabase = fakeSupabase({ [JOB]: iso(NOW - 5 * H) })

    const results = await runHeartbeatChecks(supabase, kv, NOW)

    expect(results.find((r) => r.jobId === JOB)?.status).toBe('unstamped')
    expect(vi.mocked(sendCronHeartbeatAlert).mock.calls[0]?.[3]).toBe('unstamped')
  })

  it('still reports dark when there is no run evidence at all, because absence proves nothing', async () => {
    // Most jobs do not write job_runs. An empty answer must not be read as
    // confirmation that the job is fine (L98).
    const kv = fakeKv({
      ...allFreshExcept(JOB, NOW),
      [firstSeenKey(JOB)]: iso(NOW - 48 * H),
    })
    const supabase = fakeSupabase({})

    const results = await runHeartbeatChecks(supabase, kv, NOW)

    expect(results.find((r) => r.jobId === JOB)?.status).toBe('never_ran')
  })

  it('still reports dark when the evidence is older than the staleness threshold', async () => {
    const kv = fakeKv({
      ...allFreshExcept(JOB, NOW),
      [heartbeatKey(JOB)]: iso(NOW - 40 * H),
    })
    const stale = cronJob(JOB).staleMs
    const supabase = fakeSupabase({ [JOB]: iso(NOW - stale - H) })

    const results = await runHeartbeatChecks(supabase, kv, NOW)

    expect(results.find((r) => r.jobId === JOB)?.status).toBe('stale')
  })

  it('still reports dark when the evidence could not be read, rather than falling silent', async () => {
    // A guard that goes quiet when its confirming source fails is worse than
    // one that never had the source (L345).
    const kv = fakeKv({
      ...allFreshExcept(JOB, NOW),
      [firstSeenKey(JOB)]: iso(NOW - 48 * H),
    })
    const supabase = fakeSupabase({ [JOB]: iso(NOW - H) }, { runsError: true })

    const results = await runHeartbeatChecks(supabase, kv, NOW)

    expect(results.find((r) => r.jobId === JOB)?.status).toBe('never_ran')
  })

  it('still reports dark when the recorded finish time cannot be parsed (L50)', async () => {
    // A value read out of the database goes straight into a comparison against
    // the staleness threshold, and an unparseable one compares false against
    // every number. It has to land on the side that keeps the accusation, not
    // the side that withdraws it.
    const kv = fakeKv({
      ...allFreshExcept(JOB, NOW),
      [firstSeenKey(JOB)]: iso(NOW - 48 * H),
    })
    const supabase = fakeSupabase({ [JOB]: 'yesterday afternoon' })

    const results = await runHeartbeatChecks(supabase, kv, NOW)

    expect(results.find((r) => r.jobId === JOB)?.status).toBe('never_ran')
  })

  it('does not consult job_runs for a healthy job, so the common path costs nothing', async () => {
    const consulted: string[] = []
    const supabase = {
      from: (table: string) => {
        consulted.push(table)
        return { select: () => ({ eq: () => Promise.resolve({ data: [{ organization_id: 'org-1' }], error: null }) }) }
      },
    } as unknown as SupabaseClient
    const kv = fakeKv(Object.fromEntries(CRON_JOBS.map((j) => [heartbeatKey(j.id), iso(NOW - 1)])))

    await runHeartbeatChecks(supabase, kv, NOW)

    expect(consulted).not.toContain('job_runs')
  })
})

describe('a standing condition', () => {
  it('backs off its reminders instead of repeating at the same rate', async () => {
    const kv = fakeKv({
      ...allFreshExcept(JOB, NOW),
      [firstSeenKey(JOB)]: iso(NOW - 48 * H),
    })
    const supabase = fakeSupabase({})

    await runHeartbeatChecks(supabase, kv, NOW)
    expect(kv.ttls.get(`cron-heartbeat:${JOB}:cooldown`)).toBe(BACKOFF_STEPS_SECONDS[0])

    // The cooldown holds the next tick silent.
    refreshOthers(kv, JOB, NOW + H)
    await runHeartbeatChecks(supabase, kv, NOW + H)
    expect(vi.mocked(sendCronHeartbeatAlert)).toHaveBeenCalledTimes(1)

    // Past it, the reminder goes and the NEXT gap is longer.
    kv.store.delete(`cron-heartbeat:${JOB}:cooldown`)
    refreshOthers(kv, JOB, NOW + 7 * H)
    await runHeartbeatChecks(supabase, kv, NOW + 7 * H)
    expect(vi.mocked(sendCronHeartbeatAlert)).toHaveBeenCalledTimes(2)
    expect(kv.ttls.get(`cron-heartbeat:${JOB}:cooldown`)).toBe(BACKOFF_STEPS_SECONDS[1])
  })

  it('tells the alert it is a repeat, carrying when the condition was first reported', async () => {
    const kv = fakeKv({
      ...allFreshExcept(JOB, NOW),
      [firstSeenKey(JOB)]: iso(NOW - 48 * H),
    })
    const supabase = fakeSupabase({})

    await runHeartbeatChecks(supabase, kv, NOW)
    expect(vi.mocked(sendCronHeartbeatAlert).mock.calls[0]?.[5]).toBeNull()

    kv.store.delete(`cron-heartbeat:${JOB}:cooldown`)
    refreshOthers(kv, JOB, NOW + 7 * H)
    await runHeartbeatChecks(supabase, kv, NOW + 7 * H)

    const repeat = vi.mocked(sendCronHeartbeatAlert).mock.calls[1]?.[5] as { since: string; alerts: number }
    expect(repeat.alerts).toBe(1)
    expect(repeat.since).toBe(iso(NOW))
  })

  // The condition is keyed on the job, while the alert's header and fix depend on
  // the status, so a job that went from never ran to unstamped was posted as
  // "still" with "nothing about it has changed" (#1768).
  it('posts a change of status under the same job at once, as a new condition', async () => {
    const kv = fakeKv({
      ...allFreshExcept(JOB, NOW),
      [firstSeenKey(JOB)]: iso(NOW - 48 * H),
    })
    await runHeartbeatChecks(fakeSupabase({}), kv, NOW)
    expect(vi.mocked(sendCronHeartbeatAlert).mock.calls[0]?.[3]).toBe('never_ran')

    // Inside the cooldown, the job is seen finishing runs without stamping.
    refreshOthers(kv, JOB, NOW + H)
    await runHeartbeatChecks(fakeSupabase({ [JOB]: iso(NOW + H - 60_000) }), kv, NOW + H)

    expect(vi.mocked(sendCronHeartbeatAlert)).toHaveBeenCalledTimes(2)
    const second = vi.mocked(sendCronHeartbeatAlert).mock.calls[1]
    expect(second?.[3]).toBe('unstamped')
    expect(second?.[5]).toBeNull()
    expect(await readCondition(kv, `cron-heartbeat:${JOB}`)).toMatchObject({ alerts: 1, since: iso(NOW + H) })
  })

  it('tells the alert nothing has changed only when the status is the one already posted', async () => {
    const kv = fakeKv({
      ...allFreshExcept(JOB, NOW),
      [firstSeenKey(JOB)]: iso(NOW - 48 * H),
    })
    await runHeartbeatChecks(fakeSupabase({}), kv, NOW)
    kv.store.delete(`cron-heartbeat:${JOB}:cooldown`)
    refreshOthers(kv, JOB, NOW + 7 * H)
    await runHeartbeatChecks(fakeSupabase({}), kv, NOW + 7 * H)

    expect(vi.mocked(sendCronHeartbeatAlert).mock.calls[0]?.[7]).toBe(false)
    expect(vi.mocked(sendCronHeartbeatAlert).mock.calls[1]?.[7]).toBe(true)
  })

  it('posts a condition stored before fingerprints as new once its cooldown has passed', async () => {
    const kv = fakeKv({
      ...allFreshExcept(JOB, NOW),
      [firstSeenKey(JOB)]: iso(NOW - 48 * H),
      [`cron-heartbeat:${JOB}:condition`]: JSON.stringify({ since: iso(NOW - 30 * H), alerts: 3 }),
    })
    await runHeartbeatChecks(fakeSupabase({}), kv, NOW)

    expect(vi.mocked(sendCronHeartbeatAlert).mock.calls[0]?.[5]).toBeNull()
    expect(await readCondition(kv, `cron-heartbeat:${JOB}`)).toMatchObject({ alerts: 1, since: iso(NOW) })
  })

  it('forgets the condition once the job reports healthy, so a recurrence is reported at once', async () => {
    const kv = fakeKv({
      ...allFreshExcept(JOB, NOW),
      [firstSeenKey(JOB)]: iso(NOW - 48 * H),
    })
    const supabase = fakeSupabase({})

    await runHeartbeatChecks(supabase, kv, NOW)
    expect(await readCondition(kv, `cron-heartbeat:${JOB}`)).not.toBeNull()

    // The job starts stamping again.
    kv.store.set(heartbeatKey(JOB), iso(NOW + 8 * H))
    refreshOthers(kv, JOB, NOW + 8 * H)
    await runHeartbeatChecks(supabase, kv, NOW + 8 * H)

    expect(await readCondition(kv, `cron-heartbeat:${JOB}`)).toBeNull()
    expect(kv.store.has(`cron-heartbeat:${JOB}:cooldown`)).toBe(false)
  })
})
