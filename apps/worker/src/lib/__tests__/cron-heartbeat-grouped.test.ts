/**
 * One page for one cause (#2117 A).
 *
 * The heartbeat check used to judge and post every watched job on its own, so
 * one missed schedule paged once per job on it. On 2026-10-14 Cloudflare did not
 * run the `*\/5` schedule at 21:35, 21:40 and 21:45 UTC and three "is dark" pages
 * went out for it. On 2026-10-21 the 04:00 UTC `*\/15` run stopped with
 * buyer-sales-checks and click-path-checks both started and neither finished,
 * and it posted two "started and never finished" pages at 04:12 and two
 * recoveries at 04:16, for one stopped run.
 *
 * Now a schedule whose every watched job is dark together is one page listing
 * them, and the unfinished jobs of one scheduled run are one page and one
 * recovery. Each job keeps its own backoff, paged record and incident, so the
 * reminder schedule, the all-clear and the incident record work as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../slack', () => ({
  sendCronHeartbeatAlert: vi.fn(async () => true),
  sendCronHeartbeatRecoveryAlert: vi.fn(async () => true),
  sendCronHeartbeatGroupAlert: vi.fn(async () => true),
  sendCronHeartbeatGroupRecoveryAlert: vi.fn(async () => true),
}))

import {
  sendCronHeartbeatAlert,
  sendCronHeartbeatRecoveryAlert,
  sendCronHeartbeatGroupAlert,
  sendCronHeartbeatGroupRecoveryAlert,
} from '../slack'
import { claimLedger, gate, until } from './_claims-double'
import {
  runHeartbeatChecks,
  scheduledSlot,
  alertedStatusKey,
  backoffKey,
  completedKey,
  completedWatchKey,
  heartbeatKey,
  CRON_JOBS,
} from '../cron-heartbeat'
import { BACKOFF_STEPS_SECONDS, backoffCooldownKey } from '../alert-backoff'
import { alertRowListAnswer } from '../../__tests__/helpers/slack-alert-read'

const MIN = 60_000
const H = 60 * MIN
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

/** The Slack org list, and an empty job_runs answer: nothing vouches for a dark job. */
function fakeSupabase(orgRows: { organization_id: string }[] = [{ organization_id: 'org-1' }]): SupabaseClient {
  const runs = {
    select: () => runs,
    eq: () => runs,
    not: () => runs,
    order: () => runs,
    limit: () => Promise.resolve({ data: [], error: null }),
  }
  return {
    from: (table: string) =>
      table === 'job_runs' ? runs : { select: () => alertRowListAnswer({ data: orgRows, error: null }) },
  } as unknown as SupabaseClient
}

const onSchedule = (cron: string) => CRON_JOBS.filter((j) => j.triggerCron === cron && !j.worker)
const FIVE = () => onSchedule('*/5 * * * *')
const FIFTEEN = () => onSchedule('*/15 * * * *')

/**
 * Every job started a second before `nowMs`, finished, and watched for
 * completions since the day before, so only what a test changes is dark.
 */
function allFresh(nowMs: number): Record<string, string> {
  return Object.fromEntries(
    CRON_JOBS.flatMap((j) => [
      [heartbeatKey(j.id), iso(nowMs - 1_000)],
      [completedKey(j.id), iso(nowMs - 500)],
      [completedWatchKey(j.id), iso(nowMs - 24 * H)],
    ]),
  )
}

/**
 * Two ticks of the check overlapping (#2062): both started, the post the winner
 * reaches held until the other tick has finished, then released. Two ticks that
 * took one group's claims job by job could each win some and post a partial
 * page each without waiting on the held one, which is what this exposes (L157).
 */
async function untilOneFinishes(run: () => Promise<unknown>, open: () => void): Promise<void> {
  let finished = 0
  const a = run().then(() => { finished++ })
  const b = run().then(() => { finished++ })
  await until(() => finished >= 1, 'one of the two ticks finishing')
  open()
  await Promise.all([a, b])
}

/** Every job except `except` ran again just before `nowMs`, so a later check sees only the jobs under test. */
function refresh(kv: ReturnType<typeof fakeKv>, nowMs: number, except: readonly { id: string }[]) {
  for (const j of CRON_JOBS) {
    if (except.some((e) => e.id === j.id)) continue
    kv.store.set(heartbeatKey(j.id), iso(nowMs - 1_000))
    kv.store.set(completedKey(j.id), iso(nowMs - 500))
  }
}

beforeEach(() => {
  for (const f of [sendCronHeartbeatAlert, sendCronHeartbeatRecoveryAlert, sendCronHeartbeatGroupAlert, sendCronHeartbeatGroupRecoveryAlert]) {
    vi.mocked(f).mockReset().mockResolvedValue(true)
  }
})

// ── A missed schedule ──────────────────────────────────────────────────────────

describe('a missed schedule is one page about the schedule (#2117, 2026-10-14)', () => {
  // The last `*/5` run started at 21:30 UTC; Cloudflare skipped 21:35, 21:40 and 21:45.
  const LAST_FIVE = Date.parse('2026-10-14T21:30:00.400Z')
  const NOW = Date.parse('2026-10-14T21:48:35.000Z')

  function missedFive(extra: Record<string, string> = {}) {
    const seed = allFresh(NOW)
    for (const j of FIVE()) {
      seed[heartbeatKey(j.id)] = iso(LAST_FIVE + 50)
      seed[completedKey(j.id)] = iso(LAST_FIVE + 20_000)
    }
    return fakeKv({ ...seed, ...extra })
  }

  it('the registry has several jobs on the five minute schedule, so the replay groups something', () => {
    expect(FIVE().length).toBeGreaterThanOrEqual(3)
  })

  it('posts one page naming every job on the schedule, and no page per job', async () => {
    const results = await runHeartbeatChecks(fakeSupabase(), missedFive(), NOW)

    expect(sendCronHeartbeatAlert).not.toHaveBeenCalled()
    expect(sendCronHeartbeatGroupAlert).toHaveBeenCalledTimes(1)
    const [, orgId, group, standing] = vi.mocked(sendCronHeartbeatGroupAlert).mock.calls[0]
    expect(orgId).toBe('org-1')
    expect(standing).toBeNull()
    expect(group).toMatchObject({ status: 'stale', triggerCron: '*/5 * * * *', runAt: iso(LAST_FIVE + 50) })
    expect(group.jobs.map((j) => j.label)).toEqual(FIVE().map((j) => j.label))
    // Each job is still judged and reported as itself.
    for (const j of FIVE()) expect(results.find((r) => r.jobId === j.id)).toMatchObject({ status: 'stale', alerted: true })
    expect(results).toHaveLength(CRON_JOBS.length)
  })

  it('sends one page to each organization', async () => {
    await runHeartbeatChecks(fakeSupabase([{ organization_id: 'org-1' }, { organization_id: 'org-2' }]), missedFive(), NOW)
    expect(vi.mocked(sendCronHeartbeatGroupAlert).mock.calls.map((c) => c[1])).toEqual(['org-1', 'org-2'])
  })

  it('control: one dark job on a schedule whose other jobs ran pages as itself', async () => {
    const [first] = FIVE()
    const kv = fakeKv({ ...allFresh(NOW), [heartbeatKey(first.id)]: iso(LAST_FIVE) })
    await runHeartbeatChecks(fakeSupabase(), kv, NOW)
    expect(sendCronHeartbeatGroupAlert).not.toHaveBeenCalled()
    expect(sendCronHeartbeatAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendCronHeartbeatAlert).mock.calls[0][2]).toMatchObject({ id: first.id })
  })

  it('a job on the schedule not yet watched (a fresh deploy) does not keep the rest from one page', async () => {
    const [newcomer, ...rest] = FIVE()
    const kv = missedFive()
    kv.store.delete(heartbeatKey(newcomer.id))
    kv.store.delete(completedKey(newcomer.id))
    const results = await runHeartbeatChecks(fakeSupabase(), kv, NOW)
    expect(results.find((r) => r.jobId === newcomer.id)?.status).toBe('pending')
    expect(sendCronHeartbeatAlert).not.toHaveBeenCalled()
    expect(sendCronHeartbeatGroupAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendCronHeartbeatGroupAlert).mock.calls[0][2].jobs.map((j) => j.label)).toEqual(rest.map((j) => j.label))
  })

  it('keeps each job\'s own paged record, so each incident is still its own', async () => {
    const kv = missedFive()
    await runHeartbeatChecks(fakeSupabase(), kv, NOW)
    for (const j of FIVE()) expect(JSON.parse(kv.store.get(alertedStatusKey(j.id))!)).toMatchObject({ status: 'stale' })
  })

  it('reminds once for the schedule when its reminder is due, not once per job', async () => {
    const kv = missedFive()
    await runHeartbeatChecks(fakeSupabase(), kv, NOW)
    // Inside the cooldown: nothing.
    await runHeartbeatChecks(fakeSupabase(), kv, NOW + MIN)
    expect(sendCronHeartbeatGroupAlert).toHaveBeenCalledTimes(1)
    // Past the first backoff step, still missed: one reminder for the schedule.
    const later = NOW + BACKOFF_STEPS_SECONDS[0] * 1000 + MIN
    refresh(kv, later, FIVE())
    // KV expires the cooldown at its TTL; this double keeps keys, so it is expired by hand.
    for (const j of FIVE()) kv.store.delete(backoffCooldownKey(backoffKey(j.id)))
    await runHeartbeatChecks(fakeSupabase(), kv, later)
    expect(sendCronHeartbeatAlert).not.toHaveBeenCalled()
    expect(sendCronHeartbeatGroupAlert).toHaveBeenCalledTimes(2)
    expect(vi.mocked(sendCronHeartbeatGroupAlert).mock.calls[1][3]).toMatchObject({ alerts: 1 })
  })

  it('a page Slack refused records no cooldown and frees every claim, so the next minute posts it again', async () => {
    const kv = missedFive()
    const { claims, held } = claimLedger()
    vi.mocked(sendCronHeartbeatGroupAlert).mockResolvedValueOnce(false)
    await runHeartbeatChecks(fakeSupabase(), kv, NOW, claims)
    expect([...held]).toEqual([])
    await runHeartbeatChecks(fakeSupabase(), kv, NOW + MIN, claims)
    expect(sendCronHeartbeatGroupAlert).toHaveBeenCalledTimes(2)
    expect(sendCronHeartbeatAlert).not.toHaveBeenCalled()
  })

  it('a page that throws keeps every claim, since it may have reached Slack', async () => {
    const kv = missedFive()
    const { claims, held } = claimLedger()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(sendCronHeartbeatGroupAlert).mockImplementationOnce(async () => { throw new Error('Network connection lost.') })
    await expect(runHeartbeatChecks(fakeSupabase(), kv, NOW, claims)).rejects.toThrow('Network connection lost.')
    for (const j of FIVE()) expect(held.has(`minute-alert:page:cron-heartbeat:${j.id}`)).toBe(true)
    await runHeartbeatChecks(fakeSupabase(), kv, NOW + MIN, claims)
    expect(sendCronHeartbeatGroupAlert).toHaveBeenCalledTimes(1)
    vi.mocked(console.error).mockRestore()
  })

  it('posts once across two overlapping ticks, under each job\'s page claim', async () => {
    const held = gate<boolean>()
    vi.mocked(sendCronHeartbeatGroupAlert).mockImplementationOnce(() => held.promise)
    const kv = missedFive()
    const { claims } = claimLedger()
    await untilOneFinishes(() => runHeartbeatChecks(fakeSupabase(), kv, NOW, claims), () => held.open(true))
    expect(sendCronHeartbeatGroupAlert).toHaveBeenCalledTimes(1)
    expect(sendCronHeartbeatAlert).not.toHaveBeenCalled()
  })

  it('a tick that cannot take the schedule\'s claims leaves every job to the tick taking them, so the page is never split', async () => {
    const kv = missedFive()
    const { claims, log, held } = claimLedger()
    held.add('minute-alert:page:cron-heartbeat:stale bidspoke-worker */5 * * * *')
    const results = await runHeartbeatChecks(fakeSupabase(), kv, NOW, claims)
    expect(sendCronHeartbeatGroupAlert).not.toHaveBeenCalled()
    expect(sendCronHeartbeatAlert).not.toHaveBeenCalled()
    expect(log.filter((l) => l.startsWith('claim minute-alert:page:cron-heartbeat:') && !l.includes(' */5 '))).toEqual([])
    for (const j of FIVE()) expect(results.find((r) => r.jobId === j.id)).toMatchObject({ status: 'stale', alerted: false })
  })

  it('makes no claim call while every job on the schedule is inside its cooldown', async () => {
    const kv = missedFive()
    await runHeartbeatChecks(fakeSupabase(), kv, NOW)
    const { claims, log } = claimLedger()
    await runHeartbeatChecks(fakeSupabase(), kv, NOW + MIN, claims)
    expect(log).toEqual([])
  })
})

// ── A run that started and never finished ──────────────────────────────────────

describe('the unfinished jobs of one run are one page and one recovery (#2117, 2026-10-21)', () => {
  // The 04:00 UTC `*/15` invocation started at 04:00:51 and was killed with no outcome record.
  const RUN_START = Date.parse('2026-10-21T04:00:51.391Z')
  const PAGED_AT = Date.parse('2026-10-21T04:12:05.000Z')
  const NEXT_RUN = Date.parse('2026-10-21T04:15:40.000Z')
  const stopped = () => FIFTEEN().filter((j) => j.id === 'buyer-sales-checks' || j.id === 'click-path-checks')

  /** The 04:00 run: the two jobs started and never finished; anything else on the schedule finished. */
  function stoppedRun() {
    const seed = allFresh(PAGED_AT)
    for (const j of FIFTEEN()) {
      seed[heartbeatKey(j.id)] = iso(RUN_START + 30)
      seed[completedKey(j.id)] = iso(RUN_START + 40_000)
    }
    for (const j of stopped()) seed[completedKey(j.id)] = iso(RUN_START - 15 * MIN + 70_000)
    return fakeKv(seed)
  }

  it('the replay is on the registry as it stands: both jobs are on the 15 minute schedule', () => {
    expect(stopped().map((j) => j.id).sort()).toEqual(['buyer-sales-checks', 'click-path-checks'])
  })

  it('pages once, naming both jobs and the run, then sends one recovery when the next run finishes both', async () => {
    const kv = stoppedRun()
    const paged = await runHeartbeatChecks(fakeSupabase(), kv, PAGED_AT)
    for (const j of stopped()) expect(paged.find((r) => r.jobId === j.id)).toMatchObject({ status: 'vanished', alerted: true })

    expect(sendCronHeartbeatAlert).not.toHaveBeenCalled()
    expect(sendCronHeartbeatGroupAlert).toHaveBeenCalledTimes(1)
    const group = vi.mocked(sendCronHeartbeatGroupAlert).mock.calls[0][2]
    expect(group).toMatchObject({ status: 'vanished', triggerCron: '*/15 * * * *', runAt: '2026-10-21T04:00:00.000Z' })
    expect(group.jobs.map((j) => j.label).sort()).toEqual(stopped().map((j) => j.label).sort())

    // 04:15: the next run starts and finishes both.
    for (const j of stopped()) {
      kv.store.set(heartbeatKey(j.id), iso(NEXT_RUN))
      kv.store.set(completedKey(j.id), iso(NEXT_RUN + 15_000))
    }
    await runHeartbeatChecks(fakeSupabase(), kv, NEXT_RUN + 25_000)
    expect(sendCronHeartbeatRecoveryAlert).not.toHaveBeenCalled()
    expect(sendCronHeartbeatGroupRecoveryAlert).toHaveBeenCalledTimes(1)
    const recovery = vi.mocked(sendCronHeartbeatGroupRecoveryAlert).mock.calls[0][2]
    expect(recovery.jobs.map((j) => j.label).sort()).toEqual(stopped().map((j) => j.label).sort())
    // A later run finished them, not the reported one.
    expect(recovery.jobs.every((j) => j.sameRun === false)).toBe(true)

    // Stood down: nothing more.
    await runHeartbeatChecks(fakeSupabase(), kv, NEXT_RUN + 85_000)
    expect(sendCronHeartbeatGroupRecoveryAlert).toHaveBeenCalledTimes(1)
    expect(sendCronHeartbeatRecoveryAlert).not.toHaveBeenCalled()
    for (const j of stopped()) expect(kv.store.has(alertedStatusKey(j.id))).toBe(false)
  })

  it('holds the finished job\'s all-clear while the other job\'s next run is still inside its allowance, then sends one', async () => {
    const [early, late] = stopped()
    const kv = stoppedRun()
    await runHeartbeatChecks(fakeSupabase(), kv, PAGED_AT)
    kv.store.set(heartbeatKey(early.id), iso(NEXT_RUN))
    kv.store.set(completedKey(early.id), iso(NEXT_RUN + 15_000))
    kv.store.set(heartbeatKey(late.id), iso(NEXT_RUN))
    // `late` is still running its 04:15 run at 04:16.
    await runHeartbeatChecks(fakeSupabase(), kv, NEXT_RUN + 25_000)
    expect(sendCronHeartbeatRecoveryAlert).not.toHaveBeenCalled()
    expect(sendCronHeartbeatGroupRecoveryAlert).not.toHaveBeenCalled()

    kv.store.set(completedKey(late.id), iso(NEXT_RUN + 70_000))
    await runHeartbeatChecks(fakeSupabase(), kv, NEXT_RUN + 85_000)
    expect(sendCronHeartbeatRecoveryAlert).not.toHaveBeenCalled()
    expect(sendCronHeartbeatGroupRecoveryAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendCronHeartbeatGroupRecoveryAlert).mock.calls[0][2].jobs).toHaveLength(2)
  })

  it('does not hold it past the other run\'s allowance: the job that finished gets its all-clear alone', async () => {
    const [early, late] = stopped()
    const kv = stoppedRun()
    await runHeartbeatChecks(fakeSupabase(), kv, PAGED_AT)
    kv.store.set(heartbeatKey(early.id), iso(NEXT_RUN))
    kv.store.set(completedKey(early.id), iso(NEXT_RUN + 15_000))
    kv.store.set(heartbeatKey(late.id), iso(NEXT_RUN))
    // `late` never finishes its 04:15 run either: past its allowance it is unfinished again, not running.
    const pastAllowance = NEXT_RUN + late.maxRunMs + MIN
    refresh(kv, pastAllowance, FIFTEEN())
    await runHeartbeatChecks(fakeSupabase(), kv, pastAllowance)
    expect(sendCronHeartbeatRecoveryAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendCronHeartbeatRecoveryAlert).mock.calls[0][2]).toMatchObject({ label: early.label })
    expect(sendCronHeartbeatGroupRecoveryAlert).not.toHaveBeenCalled()
  })

  it('retries the grouped recovery only to the organization that did not get it', async () => {
    const orgs = [{ organization_id: 'org-1' }, { organization_id: 'org-2' }]
    const kv = stoppedRun()
    await runHeartbeatChecks(fakeSupabase(orgs), kv, PAGED_AT)
    for (const j of stopped()) {
      kv.store.set(heartbeatKey(j.id), iso(NEXT_RUN))
      kv.store.set(completedKey(j.id), iso(NEXT_RUN + 15_000))
    }
    vi.mocked(sendCronHeartbeatGroupRecoveryAlert).mockImplementation(async (_s, orgId) => orgId === 'org-1')
    await runHeartbeatChecks(fakeSupabase(orgs), kv, NEXT_RUN + 25_000)
    vi.mocked(sendCronHeartbeatGroupRecoveryAlert).mockResolvedValue(true)
    await runHeartbeatChecks(fakeSupabase(orgs), kv, NEXT_RUN + 85_000)
    expect(vi.mocked(sendCronHeartbeatGroupRecoveryAlert).mock.calls.map((c) => c[1])).toEqual(['org-1', 'org-2', 'org-2'])
    expect(sendCronHeartbeatRecoveryAlert).not.toHaveBeenCalled()
  })

  it('a tick that cannot take the run\'s all-clear claims leaves the all-clear to the tick taking them', async () => {
    const kv = stoppedRun()
    await runHeartbeatChecks(fakeSupabase(), kv, PAGED_AT)
    for (const j of stopped()) {
      kv.store.set(heartbeatKey(j.id), iso(NEXT_RUN))
      kv.store.set(completedKey(j.id), iso(NEXT_RUN + 15_000))
    }
    const { claims, log, held } = claimLedger()
    held.add('minute-alert:all-clear:cron-heartbeat:vanished bidspoke-worker */15 * * * * 2026-10-21T04:00:00.000Z')
    await runHeartbeatChecks(fakeSupabase(), kv, NEXT_RUN + 25_000, claims)
    expect(sendCronHeartbeatGroupRecoveryAlert).not.toHaveBeenCalled()
    expect(sendCronHeartbeatRecoveryAlert).not.toHaveBeenCalled()
    expect(log).toEqual(['claim minute-alert:all-clear:cron-heartbeat:vanished bidspoke-worker */15 * * * * 2026-10-21T04:00:00.000Z'])
    // Still owed: the next tick that can take them sends it.
    for (const j of stopped()) expect(kv.store.has(alertedStatusKey(j.id))).toBe(true)
  })

  it('sends the grouped recovery once across overlapping ticks, under each job\'s all-clear claim', async () => {
    const kv = stoppedRun()
    await runHeartbeatChecks(fakeSupabase(), kv, PAGED_AT)
    for (const j of stopped()) {
      kv.store.set(heartbeatKey(j.id), iso(NEXT_RUN))
      kv.store.set(completedKey(j.id), iso(NEXT_RUN + 15_000))
    }
    const held = gate<boolean>()
    vi.mocked(sendCronHeartbeatGroupRecoveryAlert).mockImplementationOnce(() => held.promise)
    const { claims } = claimLedger()
    await untilOneFinishes(() => runHeartbeatChecks(fakeSupabase(), kv, NEXT_RUN + 25_000, claims), () => held.open(true))
    expect(sendCronHeartbeatGroupRecoveryAlert).toHaveBeenCalledTimes(1)
    expect(sendCronHeartbeatRecoveryAlert).not.toHaveBeenCalled()
  })
})

// ── Which scheduled run a start belongs to ─────────────────────────────────────

describe('scheduledSlot: the scheduled time a run that started at a moment belongs to', () => {
  it.each([
    ['*/15 * * * *', '2026-10-21T04:00:51.391Z', '2026-10-21T04:00:00.000Z'],
    ['*/15 * * * *', '2026-10-21T04:14:59.000Z', '2026-10-21T04:00:00.000Z'],
    ['*/5 * * * *', '2026-10-14T21:30:00.400Z', '2026-10-14T21:30:00.000Z'],
    ['* * * * *', '2026-10-14T21:30:59.900Z', '2026-10-14T21:30:00.000Z'],
    ['23 * * * *', '2026-10-14T14:24:10.000Z', '2026-10-14T14:23:00.000Z'],
    ['37 */2 * * *', '2026-10-14T15:10:00.000Z', '2026-10-14T14:37:00.000Z'],
    ['0 13 * * *', '2026-10-15T09:00:00.000Z', '2026-10-14T13:00:00.000Z'],
  ])('%s started at %s belongs to %s', (cron, at, slot) => {
    expect(scheduledSlot(cron, Date.parse(at))).toBe(Date.parse(slot))
  })

  it.each(['0 13 * * 1', '*/0 * * * *', 'every minute', '61 * * * *'])('answers null for %s, a shape it does not read', (cron) => {
    expect(scheduledSlot(cron, Date.parse('2026-10-14T13:00:00Z'))).toBeNull()
  })

  it('answers null for an unreadable start', () => {
    expect(scheduledSlot('*/5 * * * *', Number.NaN)).toBeNull()
  })
})
