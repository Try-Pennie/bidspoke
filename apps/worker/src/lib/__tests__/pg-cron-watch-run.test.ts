import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../slack', () => ({
  sendPgCronAlert: vi.fn(async () => true),
  sendPgCronRecoveryAlert: vi.fn(async () => true),
}))

import { sendPgCronAlert, sendPgCronRecoveryAlert } from '../slack'
import { runPgCronWatch, type PgCronJob } from '../pg-cron-watch'
import { outboxEvents, transitions } from './_incident-events'

/**
 * The orchestration half of the database scheduled-job watch (#770): what
 * reaches Slack, how often, and what happens when the check itself cannot read.
 */
const NOW = Date.parse('2026-08-17T20:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const HOUR = 3_600_000

let nextJobid = 100
const healthy = (name: string): PgCronJob => ({
  jobid: nextJobid++,
  jobname: name,
  schedule: '0 3 * * *',
  active: true,
  failures_in_window: 0,
  last_failure_at: null,
  last_failure_message: null,
  last_success_at: iso(NOW - HOUR),
})

function fakeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  } as unknown as KVNamespace & { store: Map<string, string> }
}

function fakeSupabase(rows: PgCronJob[] | null, opts: { rpcError?: string; orgs?: string[] } = {}) {
  return {
    rpc: vi.fn(async () =>
      opts.rpcError ? { data: null, error: { message: opts.rpcError } } : { data: rows, error: null },
    ),
    from: () => ({
      select: () => ({
        eq: () =>
          Promise.resolve({
            data: (opts.orgs ?? ['org-1']).map((organization_id) => ({ organization_id })),
            error: null,
          }),
      }),
    }),
  } as unknown as SupabaseClient
}

beforeEach(() => {
  vi.mocked(sendPgCronAlert).mockClear()
  vi.mocked(sendPgCronAlert).mockResolvedValue(true)
  vi.mocked(sendPgCronRecoveryAlert).mockClear()
  vi.mocked(sendPgCronRecoveryAlert).mockResolvedValue(true)
})

describe('runPgCronWatch: the quiet path', () => {
  it('says nothing when every job is healthy', async () => {
    const results = await runPgCronWatch(fakeSupabase([healthy('a'), healthy('b')]), fakeKv(), NOW)
    expect(results.every((r) => r.status === 'healthy')).toBe(true)
    expect(sendPgCronAlert).not.toHaveBeenCalled()
  })
})

describe('runPgCronWatch: a failing job', () => {
  const failing: PgCronJob = {
    ...healthy('refresh-workflow-stats-daily-full'),
    schedule: '45 3 * * *',
    failures_in_window: 24,
    last_failure_at: iso(NOW - 16 * HOUR),
    last_failure_message: 'ERROR: duplicate key value violates unique constraint',
  }

  it('alerts every Slack org once', async () => {
    const results = await runPgCronWatch(
      fakeSupabase([healthy('a'), failing], { orgs: ['org-1', 'org-2'] }),
      fakeKv(),
      NOW,
    )
    expect(results.find((r) => r.jobname === failing.jobname)?.status).toBe('failing')
    expect(sendPgCronAlert).toHaveBeenCalledTimes(2)
  })

  it('stays quiet on the next run while the cooldown holds', async () => {
    const kv = fakeKv()
    const supabase = fakeSupabase([failing])
    await runPgCronWatch(supabase, kv, NOW)
    vi.mocked(sendPgCronAlert).mockClear()
    await runPgCronWatch(supabase, kv, NOW + HOUR)
    expect(sendPgCronAlert).not.toHaveBeenCalled()
  })

  it('does not arm the cooldown when the alert was not delivered', async () => {
    // Otherwise a Slack outage during the first bad run buys six hours of
    // silence about a condition nobody was ever told.
    vi.mocked(sendPgCronAlert).mockResolvedValue(false)
    const kv = fakeKv()
    await runPgCronWatch(fakeSupabase([failing]), kv, NOW)
    // The running-end marker may be written (the incident is ongoing), but the
    // cooldown must not be armed and no recovery start may be owed for an alert
    // nobody received (#851).
    const keys = [...kv.store.keys()]
    expect(keys).not.toContain(`pg-cron-watch:${failing.jobname}:alerted`)
    expect(keys.some((k) => k.startsWith('pg-cron-watch-recovery:'))).toBe(false)
  })
})

describe('runPgCronWatch: a reported failure the job has recovered from', () => {
  // The 2026-08-18 shape: the last failure the collision bug ever produced sat
  // inside the 24h window all day while the job succeeded every 5 minutes, and
  // the watcher re-paged it every cooldown expiry (L36).
  const recovered: PgCronJob = {
    ...healthy('refresh-workflow-stats-daily'),
    schedule: '*/5 * * * *',
    failures_in_window: 1,
    last_failure_at: iso(NOW - 16 * HOUR),
    last_failure_message: 'ERROR: duplicate key value violates unique constraint',
    last_success_at: iso(NOW - 5 * 60_000),
  }

  it('remembers which failure it delivered an alert for', async () => {
    const kv = fakeKv()
    await runPgCronWatch(fakeSupabase([recovered]), kv, NOW)
    expect(kv.store.get(`pg-cron-watch:${recovered.jobname}:alerted-failure`)).toBe(recovered.last_failure_at)
  })

  it('does not re-page the same failure after the cooldown once a success followed it', async () => {
    const kv = fakeKv()
    await runPgCronWatch(fakeSupabase([recovered]), kv, NOW)
    kv.store.delete(`pg-cron-watch:${recovered.jobname}:alerted`) // the 6h cooldown expiring
    vi.mocked(sendPgCronAlert).mockClear()
    // Six hours on, the job has kept succeeding every 5 minutes; only the stale
    // failure still sits in the 24h window.
    const later = { ...recovered, last_success_at: iso(NOW + 6 * HOUR - 5 * 60_000) }
    const results = await runPgCronWatch(fakeSupabase([later]), kv, NOW + 6 * HOUR)
    expect(sendPgCronAlert).not.toHaveBeenCalled()
    expect(results[0]?.status).toBe('recovered')
  })

  it('does not remember a failure whose alert was never delivered', async () => {
    // Otherwise a Slack outage during the one pass that saw the failure converts
    // into permanent silence about it (the same reason the cooldown arms only on
    // delivery).
    vi.mocked(sendPgCronAlert).mockResolvedValue(false)
    const kv = fakeKv()
    await runPgCronWatch(fakeSupabase([recovered]), kv, NOW)
    expect(kv.store.has(`pg-cron-watch:${recovered.jobname}:alerted-failure`)).toBe(false)
    vi.mocked(sendPgCronAlert).mockResolvedValue(true)
    const results = await runPgCronWatch(fakeSupabase([recovered]), kv, NOW + HOUR)
    expect(results[0]?.status).toBe('failing')
    expect(sendPgCronAlert).toHaveBeenCalled()
  })
})

describe('runPgCronWatch: the all-clear when a job recovers (#851)', () => {
  // Silence after a page meant both "somebody fixed it" and "the cooldown is
  // still holding"; the recovery line closes that question (L98).
  const failing: PgCronJob = {
    ...healthy('reduce-finalize-stranded'),
    failures_in_window: 3,
    last_failure_at: iso(NOW - 2 * HOUR),
    last_failure_message: 'ERROR: deadlock detected',
    last_success_at: iso(NOW - 3 * HOUR),
  }

  it('posts one recovery line once a paged job is healthy again, and clears its cooldown', async () => {
    const kv = fakeKv()
    await runPgCronWatch(fakeSupabase([failing]), kv, NOW)
    expect(sendPgCronAlert).toHaveBeenCalledTimes(1)
    expect(kv.store.has(`pg-cron-watch:${failing.jobname}:alerted`)).toBe(true)

    const results = await runPgCronWatch(fakeSupabase([healthy(failing.jobname)]), kv, NOW + HOUR)
    expect(results[0]?.status).toBe('healthy')
    expect(sendPgCronRecoveryAlert).toHaveBeenCalledTimes(1)
    // The all-clear cleared the cooldown so a fresh failure pages at once.
    expect(kv.store.has(`pg-cron-watch:${failing.jobname}:alerted`)).toBe(false)
  })

  it('records the job\'s incident as the platform\'s: opened, paged, ended on the all-clear (#2099)', async () => {
    const kv = fakeKv()
    await runPgCronWatch(fakeSupabase([failing]), kv, NOW)
    await runPgCronWatch(fakeSupabase([healthy(failing.jobname)]), kv, NOW + HOUR)
    expect(transitions(kv.store)).toEqual([`opened ${failing.jobname}`, `paged ${failing.jobname}`, `ended ${failing.jobname} all_clear`])
    for (const e of outboxEvents(kv.store)) {
      expect(e).toMatchObject({ signal: 'pg-cron-watch', scope: 'platform', organizationId: null, subjectLabel: failing.jobname })
    }
  })

  it('announces nothing for a job that was never paged', async () => {
    const kv = fakeKv()
    const results = await runPgCronWatch(fakeSupabase([healthy('a')]), kv, NOW)
    expect(results[0]?.status).toBe('healthy')
    expect(sendPgCronRecoveryAlert).not.toHaveBeenCalled()
  })

  it('announces no recovery when the failure alert was never delivered', async () => {
    // The mirror of arming the cooldown only on delivery: an all-clear must never
    // follow an alert nobody received (#851).
    vi.mocked(sendPgCronAlert).mockResolvedValue(false)
    const kv = fakeKv()
    await runPgCronWatch(fakeSupabase([failing]), kv, NOW)
    vi.mocked(sendPgCronAlert).mockResolvedValue(true)
    const results = await runPgCronWatch(fakeSupabase([healthy(failing.jobname)]), kv, NOW + HOUR)
    expect(results[0]?.status).toBe('healthy')
    expect(sendPgCronRecoveryAlert).not.toHaveBeenCalled()
  })
})

describe('runPgCronWatch: a job with no run history yet', () => {
  // A migration that moves a pg_cron job unschedules and reschedules it, which
  // gives it a new jobid and orphans its run history, so the recreated job reads
  // as never having succeeded until its first slot arrives.
  const fresh: PgCronJob = {
    ...healthy('refresh-field-presence-daily-full'),
    jobid: 46,
    schedule: '52 3 * * *',
    last_success_at: null,
  }
  const stampKey = (job: PgCronJob) => `pg-cron-watch:first-seen:${job.jobid}`

  it('stamps first-seen and stays quiet while the first slot has not had to come', async () => {
    const kv = fakeKv()
    const results = await runPgCronWatch(fakeSupabase([fresh]), kv, NOW)
    expect(results[0]?.status).toBe('awaiting_first_run')
    expect(sendPgCronAlert).not.toHaveBeenCalled()
    expect(kv.store.get(stampKey(fresh))).toBe(String(NOW))
  })

  it('keeps the original first-seen stamp on later passes', async () => {
    const kv = fakeKv()
    await runPgCronWatch(fakeSupabase([fresh]), kv, NOW)
    await runPgCronWatch(fakeSupabase([fresh]), kv, NOW + HOUR)
    expect(kv.store.get(stampKey(fresh))).toBe(String(NOW))
  })

  it('pages never_succeeded once the job has had a full cadence window and still no success', async () => {
    const kv = fakeKv()
    kv.store.set(stampKey(fresh), String(NOW - 72 * HOUR))
    const results = await runPgCronWatch(fakeSupabase([fresh]), kv, NOW)
    expect(results[0]?.status).toBe('never_succeeded')
    expect(sendPgCronAlert).toHaveBeenCalled()
  })

  it('pages rather than trusting a first-seen stamp it cannot read', async () => {
    // A corrupt stamp must land on the alerting side (L50).
    const kv = fakeKv()
    kv.store.set(stampKey(fresh), 'garbage')
    const results = await runPgCronWatch(fakeSupabase([fresh]), kv, NOW)
    expect(results[0]?.status).toBe('never_succeeded')
    expect(sendPgCronAlert).toHaveBeenCalled()
  })

  it('stays quiet when the job was rescheduled with the same name and the same schedule', async () => {
    // 2026-09-04 (#1152). A migration changed only the job's COMMAND, which
    // still unschedules and reschedules it, so the job came back under a new
    // jobid with its run history orphaned. The stamp from the job's PREVIOUS
    // incarnation, written 17 days earlier under an identical name and
    // schedule, said it had been around all along, and both nightly rollups
    // paged as never having succeeded 30 minutes after a healthy deploy.
    const kv = fakeKv()
    // The stamp as the name-and-schedule keying left it: written for the job's
    // previous incarnation, and indistinguishable from a stamp for this one.
    kv.store.set(`pg-cron-watch:first-seen:${fresh.jobname}:${fresh.schedule}`, String(NOW - 17 * 24 * HOUR))

    const results = await runPgCronWatch(fakeSupabase([fresh]), kv, NOW)

    expect(results[0]?.status).toBe('awaiting_first_run')
    expect(sendPgCronAlert).not.toHaveBeenCalled()
    expect(kv.store.get(stampKey(fresh))).toBe(String(NOW))
  })

  it('pages when it cannot tell which job this is', async () => {
    // The one window where the code can run against a pg_cron_health that does
    // not return jobid: deployed ahead of its migration. Unknown identity means
    // no grace can be granted, and it says so in its own words rather than
    // reading as a job that genuinely never ran (L11, L168).
    const kv = fakeKv()
    const noIdentity = { ...fresh } as Partial<PgCronJob>
    delete noIdentity.jobid
    const results = await runPgCronWatch(fakeSupabase([noIdentity as PgCronJob]), kv, NOW)
    expect(results[0]?.status).toBe('unknown_identity')
    expect(results[0]?.detail).toMatch(/jobid/)
    expect(sendPgCronAlert).toHaveBeenCalled()
  })
})

describe('runPgCronWatch: the check itself cannot read', () => {
  it('throws rather than reporting an empty list of problems', async () => {
    // The L98 case, and the one that matters most here: returning [] on a failed
    // read makes an outage of this check indistinguishable from a database with
    // no failing jobs.
    await expect(runPgCronWatch(fakeSupabase(null, { rpcError: 'permission denied' }), fakeKv(), NOW)).rejects.toThrow(
      /permission denied/,
    )
  })

  it('throws when the response is not a list', async () => {
    await expect(runPgCronWatch(fakeSupabase(null), fakeKv(), NOW)).rejects.toThrow()
  })
})

describe('runPgCronWatch: one job must not silence the rest', () => {
  it('keeps checking after a job whose alert throws', async () => {
    // A watchdog must not share the abort behaviour of the work it watches (L71).
    vi.mocked(sendPgCronAlert).mockRejectedValueOnce(new Error('slack exploded'))
    const bad = { ...healthy('first'), failures_in_window: 1 }
    const alsoBad = { ...healthy('second'), failures_in_window: 1 }
    const results = await runPgCronWatch(fakeSupabase([bad, alsoBad]), fakeKv(), NOW)
    expect(results.length).toBe(2)
    expect(results.some((r) => r.detail.includes('slack exploded'))).toBe(true)
    expect(results.some((r) => r.status === 'failing')).toBe(true)
  })

  it('still pages when the all-clear bookkeeping cannot write (#851)', async () => {
    // The recovery markers support the page; a KV fault in them must not stop it.
    const store = new Map<string, string>()
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        if (k.startsWith('pg-cron-watch-')) throw new Error('kv write refused')
        store.set(k, v)
      },
      delete: async (k: string) => { store.delete(k) },
    } as unknown as KVNamespace
    const results = await runPgCronWatch(fakeSupabase([{ ...healthy('bad'), failures_in_window: 1 }]), kv, NOW)
    expect(sendPgCronAlert).toHaveBeenCalledTimes(1)
    expect(results[0].status).toBe('failing')
    expect(results[0].alerted).toBe(true)
  })

  it('still reports a healthy job healthy when the all-clear cannot be read (#851)', async () => {
    const kv = {
      get: async (k: string) => {
        if (k.startsWith('pg-cron-watch-')) throw new Error('kv read refused')
        return null
      },
      put: async () => {},
      delete: async () => {},
    } as unknown as KVNamespace
    const results = await runPgCronWatch(fakeSupabase([healthy('fine')]), kv, NOW)
    expect(results[0].status).toBe('healthy')
  })
})

describe('runPgCronWatch: reads a bounded window', () => {
  it('asks the database for a window rather than everything', async () => {
    // cron.job_run_details grows unboundedly and is not pruned, so an unbounded
    // read is the same row-cap trap as #115.
    const supabase = fakeSupabase([healthy('a')])
    await runPgCronWatch(supabase, fakeKv(), NOW)
    const rpc = vi.mocked((supabase as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc)
    expect(rpc).toHaveBeenCalledWith('pg_cron_health', expect.objectContaining({ window_hours: expect.any(Number) }))
  })
})
