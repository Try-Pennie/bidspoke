import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../slack', () => ({
  sendCronHeartbeatAlert: vi.fn(async () => true),
  sendCronHeartbeatRecoveryAlert: vi.fn(async () => true),
}))

import { sendCronHeartbeatAlert, sendCronHeartbeatRecoveryAlert } from '../slack'
import {
  runHeartbeatChecks,
  writeHeartbeat,
  writeHeartbeatCompleted,
  completedWatchKey,
  heartbeatKey,
  completedKey,
  firstSeenKey,
  CRON_JOBS,
  cronJob,
} from '../cron-heartbeat'

const NOW = Date.parse('2026-06-26T13:00:00.000Z')
const H = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  } as unknown as KVNamespace & { store: Map<string, string> }
}

/**
 * Answers both reads the check makes: the Slack org list, and the `job_runs`
 * cross-check it consults before accusing a job of being dark (#1332). The
 * job_runs answer is EMPTY here, which is the no-evidence case, so every
 * expectation in this file is about a job with nothing to vouch for it.
 */
function fakeSupabase(orgRows: { organization_id: string }[]): SupabaseClient {
  const runs = {
    select: () => runs,
    eq: () => runs,
    not: () => runs,
    order: () => runs,
    limit: () => Promise.resolve({ data: [], error: null }),
  }
  return {
    from: (table: string) =>
      table === 'job_runs'
        ? runs
        : { select: () => ({ eq: () => Promise.resolve({ data: orgRows, error: null }) }) },
  } as unknown as SupabaseClient
}

// Fresh every job so a job-under-test can be made stale in isolation.
function allFresh(nowMs: number): Record<string, string> {
  return Object.fromEntries(CRON_JOBS.map((j) => [heartbeatKey(j.id), iso(nowMs - 1)]))
}

beforeEach(() => {
  vi.mocked(sendCronHeartbeatAlert).mockClear()
  vi.mocked(sendCronHeartbeatRecoveryAlert).mockClear()
})

describe('CRON_JOBS registry', () => {
  it('keeps the daily batch on its legacy KV key so a live deploy does not lose its heartbeat', () => {
    // Renaming this key would reset the daily job to never_ran on deploy and
    // false-alarm during the grace window. It must stay byte-for-byte.
    expect(heartbeatKey('daily-1300')).toBe('cron-heartbeat:daily-1300')
    expect(firstSeenKey('daily-1300')).toBe('cron-heartbeat:daily-1300:first-seen')
  })

  it('registers the two-hour export cron as a watched job', () => {
    const ids = CRON_JOBS.map((j) => j.id)
    expect(ids).toContain('sightings-export')
  })

  // #541: the sightings purge is the database's own pg_cron job now, watched by
  // pg-cron-watch, so the Worker's heartbeat registry must not keep waiting for
  // two crons that no longer fire; it would page on them forever.
  it('no longer watches the retired Worker purge crons', () => {
    const ids = CRON_JOBS.map((j) => j.id)
    expect(ids).not.toContain('sightings-purge')
    expect(ids).not.toContain('sighting-bids-purge')
  })

  it('gives the two-hour job a tighter stale threshold than the daily job', () => {
    expect(cronJob('sightings-export').staleMs).toBeLessThan(cronJob('daily-1300').staleMs)
    // A 2h cadence must still tolerate one on-time run without flapping.
    expect(cronJob('sightings-export').staleMs).toBeGreaterThan(2 * H)
  })
})

describe('writeHeartbeat', () => {
  it('records the run timestamp under the per-job heartbeat key', async () => {
    const kv = fakeKv()
    await writeHeartbeat(kv, 'sightings-export', NOW)
    expect(kv.store.get(heartbeatKey('sightings-export'))).toBe(iso(NOW))
    // Does not touch a different job's key.
    expect(kv.store.get(heartbeatKey('daily-1300'))).toBeUndefined()
  })
})

describe('runHeartbeatChecks', () => {
  it('is healthy and silent when every job ran recently', async () => {
    const kv = fakeKv(allFresh(NOW))
    const results = await runHeartbeatChecks(fakeSupabase([{ organization_id: 'o1' }]), kv, NOW)
    expect(results.every((r) => r.status === 'healthy')).toBe(true)
    expect(sendCronHeartbeatAlert).not.toHaveBeenCalled()
  })

  it('alerts for the one dark job while the others stay silent', async () => {
    const kv = fakeKv({
      ...allFresh(NOW),
      [heartbeatKey('sightings-export')]: iso(NOW - 5 * H),
    })
    const results = await runHeartbeatChecks(fakeSupabase([{ organization_id: 'o1' }]), kv, NOW)

    const exp = results.find((r) => r.jobId === 'sightings-export')
    expect(exp?.status).toBe('stale')
    expect(exp?.alerted).toBe(true)
    // Exactly one alert, and it names the export job.
    expect(sendCronHeartbeatAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendCronHeartbeatAlert).mock.calls[0][2]).toMatchObject({ id: 'sightings-export' })
  })

  it('uses a per-job cooldown so one dark job does not suppress alerts for another', async () => {
    // The timeout audit already alerted (cooldown set); export goes dark next.
    // The export must still alert -- a shared cooldown key would swallow it.
    const kv = fakeKv({
      ...allFresh(NOW),
      [heartbeatKey('sightings-export')]: iso(NOW - 5 * H),
      'cron-heartbeat:timeout-audit:alerted': '1',
    })
    const results = await runHeartbeatChecks(fakeSupabase([{ organization_id: 'o1' }]), kv, NOW)

    expect(results.find((r) => r.jobId === 'sightings-export')?.alerted).toBe(true)
    expect(sendCronHeartbeatAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendCronHeartbeatAlert).mock.calls[0][2]).toMatchObject({ id: 'sightings-export' })
  })

  it('seeds a per-job first-seen marker and stays silent on a fresh deploy', async () => {
    const kv = fakeKv()
    const results = await runHeartbeatChecks(fakeSupabase([{ organization_id: 'o1' }]), kv, NOW)
    expect(results.every((r) => r.status === 'pending')).toBe(true)
    expect(sendCronHeartbeatAlert).not.toHaveBeenCalled()
    expect(kv.store.get(firstSeenKey('sightings-export'))).toBe(iso(NOW))
    expect(kv.store.get(firstSeenKey('daily-1300'))).toBe(iso(NOW))
  })

  it('alerts every distinct Slack org once for a dark job', async () => {
    const kv = fakeKv({ ...allFresh(NOW), [heartbeatKey('daily-1300')]: iso(NOW - 30 * H) })
    const res = await runHeartbeatChecks(
      fakeSupabase([{ organization_id: 'o1' }, { organization_id: 'o1' }, { organization_id: 'o2' }]),
      kv,
      NOW,
    )
    expect(res.find((r) => r.jobId === 'daily-1300')?.alerted).toBe(true)
    expect(sendCronHeartbeatAlert).toHaveBeenCalledTimes(2)
  })
})

describe('writeHeartbeatCompleted (#985)', () => {
  it('records the completion under its own per-job key, leaving the started stamp alone', async () => {
    const kv = fakeKv({ [heartbeatKey('execution-archive')]: iso(NOW - 60_000) })
    await writeHeartbeatCompleted(kv, 'execution-archive', NOW)
    expect(kv.store.get(completedKey('execution-archive'))).toBe(iso(NOW))
    expect(kv.store.get(heartbeatKey('execution-archive'))).toBe(iso(NOW - 60_000))
  })
})

describe('runHeartbeatChecks: a run that started and never finished (#985)', () => {
  it('alerts vanished for the job whose run is past its allowance without a completion', async () => {
    const archive = cronJob('execution-archive')
    const kv = fakeKv({
      ...allFresh(NOW),
      // Started well past its allowance, never completed. This is the 08-22 shape.
      [heartbeatKey(archive.id)]: iso(NOW - archive.maxRunMs - 5 * 60_000),
      // The check has watched for this job's completions since the day before.
      [completedWatchKey(archive.id)]: iso(NOW - 24 * H),
    })
    const results = await runHeartbeatChecks(fakeSupabase([{ organization_id: 'org-1' }]), kv, NOW)

    const r = results.find((x) => x.jobId === archive.id)!
    expect(r.status).toBe('vanished')
    expect(r.alerted).toBe(true)
    expect(vi.mocked(sendCronHeartbeatAlert)).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      expect.objectContaining({ id: archive.id }),
      'vanished',
      expect.any(Number),
      // No standing condition on the first report: this is not a reminder (#1334).
      null,
      expect.any(Number),
      // Nor can a first report say nothing has changed (#1768).
      false,
    )
    expect(results.filter((x) => x.jobId !== archive.id).every((x) => x.status === 'healthy')).toBe(true)
  })

  it('stays healthy when that same run has a completed stamp after its start', async () => {
    const archive = cronJob('execution-archive')
    const started = NOW - archive.maxRunMs - 5 * 60_000
    const kv = fakeKv({
      ...allFresh(NOW),
      [heartbeatKey(archive.id)]: iso(started),
      [completedKey(archive.id)]: iso(started + 20 * 60_000),
    })
    const results = await runHeartbeatChecks(fakeSupabase([{ organization_id: 'org-1' }]), kv, NOW)

    expect(results.find((x) => x.jobId === archive.id)!.status).toBe('healthy')
    expect(vi.mocked(sendCronHeartbeatAlert)).not.toHaveBeenCalled()
  })
})

describe('runHeartbeatChecks: runs that predate the completed stamp (#1207)', () => {
  it('does not alert on a run that started before the check first looked for completions, and records that it is now looking', async () => {
    const archive = cronJob('execution-archive')
    const started = NOW - archive.maxRunMs - 5 * 60_000
    // No completed stamp and no watch marker: the first check after the deploy
    // that introduced completed stamps. Five jobs looked exactly like this on
    // 2026-09-07 and were all reported as killed.
    const kv = fakeKv({ ...allFresh(NOW), [heartbeatKey(archive.id)]: iso(started) })
    const results = await runHeartbeatChecks(fakeSupabase([{ organization_id: 'org-1' }]), kv, NOW)

    const r = results.find((x) => x.jobId === archive.id)!
    expect(r.status).toBe('healthy')
    expect(sendCronHeartbeatAlert).not.toHaveBeenCalled()
    expect(kv.store.get(completedWatchKey(archive.id))).toBe(iso(NOW))
  })

  it('alerts on the next run that starts after watching began and never completes', async () => {
    const archive = cronJob('execution-archive')
    const watching = NOW - 3 * H
    const kv = fakeKv({
      ...allFresh(NOW),
      [completedWatchKey(archive.id)]: iso(watching),
      [heartbeatKey(archive.id)]: iso(watching + H),
    })
    const results = await runHeartbeatChecks(fakeSupabase([{ organization_id: 'org-1' }]), kv, NOW)

    expect(results.find((x) => x.jobId === archive.id)!.status).toBe('vanished')
    expect(sendCronHeartbeatAlert).toHaveBeenCalledTimes(1)
  })

  it('does not move the watch marker once it exists', async () => {
    const archive = cronJob('execution-archive')
    const kv = fakeKv({
      ...allFresh(NOW),
      [completedWatchKey(archive.id)]: iso(NOW - 3 * H),
      [heartbeatKey(archive.id)]: iso(NOW - 60_000),
    })
    await runHeartbeatChecks(fakeSupabase([{ organization_id: 'org-1' }]), kv, NOW)

    expect(kv.store.get(completedWatchKey(archive.id))).toBe(iso(NOW - 3 * H))
  })
})

// #2057. Every minute job shares one invocation, which took up to 320 s in the
// week to 2026-10-14, and each run's start overwrites the last. So one minute
// job's late finish cannot be told from a kill at the next tick, and a real kill
// is masked by the next start. Minute jobs are judged on a drought of finished
// runs instead.
describe('runHeartbeatChecks: minute jobs are judged on finished runs, not one late run (#2057)', () => {
  const sweep = () => cronJob('unconfirmed-write-sweep')

  it('does not call the 2026-10-14 late run killed: started 60 s ago, finished one a minute before', async () => {
    const kv = fakeKv({
      ...allFresh(NOW),
      [heartbeatKey(sweep().id)]: iso(NOW - 60_000),
      [completedKey(sweep().id)]: iso(NOW - 2 * 60_000),
      [completedWatchKey(sweep().id)]: iso(NOW - 24 * H),
    })
    const results = await runHeartbeatChecks(fakeSupabase([{ organization_id: 'org-1' }]), kv, NOW)
    expect(results.find((x) => x.jobId === sweep().id)!.status).toBe('healthy')
    expect(sendCronHeartbeatAlert).not.toHaveBeenCalled()
  })

  it('pages vanished when no run has finished for 10 minutes while new runs keep starting', async () => {
    const kv = fakeKv({
      ...allFresh(NOW),
      [heartbeatKey(sweep().id)]: iso(NOW - 30_000),
      [completedKey(sweep().id)]: iso(NOW - 11 * 60_000),
      [completedWatchKey(sweep().id)]: iso(NOW - 24 * H),
    })
    const results = await runHeartbeatChecks(fakeSupabase([{ organization_id: 'org-1' }]), kv, NOW)
    const r = results.find((x) => x.jobId === sweep().id)!
    expect(r.status).toBe('vanished')
    // The age is how long nothing has finished, not how old the latest start is.
    expect(r.ageMs).toBe(11 * 60_000)
  })

  it('does not judge a drought before it has watched for completions that long', async () => {
    const kv = fakeKv({
      ...allFresh(NOW),
      [heartbeatKey(sweep().id)]: iso(NOW - 30_000),
      [completedWatchKey(sweep().id)]: iso(NOW - 5 * 60_000),
    })
    const results = await runHeartbeatChecks(fakeSupabase([{ organization_id: 'org-1' }]), kv, NOW)
    expect(results.find((x) => x.jobId === sweep().id)!.status).toBe('healthy')
  })
})

describe('runHeartbeatChecks: a never finished page is closed when the job finishes (#2057)', () => {
  it('posts one all-clear naming the job when a run it reported finishes, then stands down', async () => {
    const archive = cronJob('execution-archive')
    const started = NOW - archive.maxRunMs - 5 * 60_000
    const kv = fakeKv({
      ...allFresh(NOW),
      [heartbeatKey(archive.id)]: iso(started),
      [completedWatchKey(archive.id)]: iso(NOW - 24 * H),
    })
    await runHeartbeatChecks(fakeSupabase([{ organization_id: 'org-1' }]), kv, NOW)
    expect(sendCronHeartbeatAlert).toHaveBeenCalledTimes(1)

    // The run finishes late; the next check sees a completion after the start.
    kv.store.set(completedKey(archive.id), iso(started + archive.maxRunMs + 8 * 60_000))
    await runHeartbeatChecks(fakeSupabase([{ organization_id: 'org-1' }]), kv, NOW + 60_000)
    expect(sendCronHeartbeatRecoveryAlert).toHaveBeenCalledTimes(1)
    expect(sendCronHeartbeatRecoveryAlert).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      expect.objectContaining({ label: archive.label, status: 'vanished' }),
      expect.any(Number),
    )

    // Stood down: a third healthy check says nothing more.
    await runHeartbeatChecks(fakeSupabase([{ organization_id: 'org-1' }]), kv, NOW + 2 * 60_000)
    expect(sendCronHeartbeatRecoveryAlert).toHaveBeenCalledTimes(1)
  })

  it('keeps the incident open when the all-clear could not be delivered, and tries again', async () => {
    const archive = cronJob('execution-archive')
    const started = NOW - archive.maxRunMs - 5 * 60_000
    const kv = fakeKv({
      ...allFresh(NOW),
      [heartbeatKey(archive.id)]: iso(started),
      [completedWatchKey(archive.id)]: iso(NOW - 24 * H),
    })
    await runHeartbeatChecks(fakeSupabase([{ organization_id: 'org-1' }]), kv, NOW)
    kv.store.set(completedKey(archive.id), iso(started + archive.maxRunMs + 8 * 60_000))
    vi.mocked(sendCronHeartbeatRecoveryAlert).mockResolvedValueOnce(false)
    await runHeartbeatChecks(fakeSupabase([{ organization_id: 'org-1' }]), kv, NOW + 60_000)
    await runHeartbeatChecks(fakeSupabase([{ organization_id: 'org-1' }]), kv, NOW + 2 * 60_000)
    expect(sendCronHeartbeatRecoveryAlert).toHaveBeenCalledTimes(2)
  })
})

describe('the never finished all-clear says only what a completion shows (#2057 review)', () => {
  const archive = () => cronJob('execution-archive')

  async function paged(kv: ReturnType<typeof fakeKv>, orgs = [{ organization_id: 'org-1' }]) {
    await runHeartbeatChecks(fakeSupabase(orgs), kv, NOW)
    expect(sendCronHeartbeatAlert).toHaveBeenCalled()
  }

  it('waits for a completion: a later start alone is not a finish', async () => {
    const started = NOW - archive().maxRunMs - 5 * 60_000
    const kv = fakeKv({ ...allFresh(NOW), [heartbeatKey(archive().id)]: iso(started), [completedWatchKey(archive().id)]: iso(NOW - 24 * H) })
    await paged(kv)
    // The next run starts; nothing has finished. Healthy by the allowance, but no all-clear.
    kv.store.set(heartbeatKey(archive().id), iso(NOW + 60_000))
    await runHeartbeatChecks(fakeSupabase([{ organization_id: 'org-1' }]), kv, NOW + 2 * 60_000)
    expect(sendCronHeartbeatRecoveryAlert).not.toHaveBeenCalled()
  })

  it('says the reported run finished late only when it was that run, and a later run otherwise', async () => {
    const started = NOW - archive().maxRunMs - 5 * 60_000
    const same = fakeKv({ ...allFresh(NOW), [heartbeatKey(archive().id)]: iso(started), [completedWatchKey(archive().id)]: iso(NOW - 24 * H) })
    await paged(same)
    same.store.set(completedKey(archive().id), iso(NOW + 30_000))
    await runHeartbeatChecks(fakeSupabase([{ organization_id: 'org-1' }]), same, NOW + 60_000)
    expect(vi.mocked(sendCronHeartbeatRecoveryAlert).mock.calls[0][2]).toMatchObject({ sameRun: true })

    vi.mocked(sendCronHeartbeatRecoveryAlert).mockClear()
    vi.mocked(sendCronHeartbeatAlert).mockClear()
    const later = fakeKv({ ...allFresh(NOW), [heartbeatKey(archive().id)]: iso(started), [completedWatchKey(archive().id)]: iso(NOW - 24 * H) })
    await paged(later)
    later.store.set(heartbeatKey(archive().id), iso(NOW + 60_000))
    later.store.set(completedKey(archive().id), iso(NOW + 90_000))
    await runHeartbeatChecks(fakeSupabase([{ organization_id: 'org-1' }]), later, NOW + 2 * 60_000)
    expect(vi.mocked(sendCronHeartbeatRecoveryAlert).mock.calls[0][2]).toMatchObject({ sameRun: false })
  })

  it('retries the all-clear only to the org that did not get it', async () => {
    const started = NOW - archive().maxRunMs - 5 * 60_000
    const orgs = [{ organization_id: 'org-1' }, { organization_id: 'org-2' }]
    const kv = fakeKv({ ...allFresh(NOW), [heartbeatKey(archive().id)]: iso(started), [completedWatchKey(archive().id)]: iso(NOW - 24 * H) })
    await paged(kv, orgs)
    kv.store.set(completedKey(archive().id), iso(NOW + 30_000))
    vi.mocked(sendCronHeartbeatRecoveryAlert).mockImplementation(async (_s, orgId) => orgId === 'org-1')
    await runHeartbeatChecks(fakeSupabase(orgs), kv, NOW + 60_000)
    vi.mocked(sendCronHeartbeatRecoveryAlert).mockImplementation(async () => true)
    await runHeartbeatChecks(fakeSupabase(orgs), kv, NOW + 2 * 60_000)
    const sentTo = vi.mocked(sendCronHeartbeatRecoveryAlert).mock.calls.map((c) => c[1])
    expect(sentTo).toEqual(['org-1', 'org-2', 'org-2'])
    await runHeartbeatChecks(fakeSupabase(orgs), kv, NOW + 3 * 60_000)
    expect(vi.mocked(sendCronHeartbeatRecoveryAlert).mock.calls).toHaveLength(3)
  })
})
