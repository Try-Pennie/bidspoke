import { describe, it, expect, vi } from 'vitest'
import {
  MINUTE_JOB_FAILING_BOUND,
  MINUTE_JOB_FAILING_SIGNAL,
  countsFailedRuns,
  failedRun,
  failedRunsKey,
  makeCompleteAfter,
  recordMinuteJobRun,
  type MinuteJobFailingDeps,
} from '../minute-job-failures'
import { recoveryKey, RECOVERY_REARM_MINUTES } from '../alert-recovery'
import { completedKey, cronJob, CRON_JOBS } from '../cron-heartbeat'
import { incidentSignal } from '../incident-signals'
import { INCIDENT_OUTBOX_PREFIX } from '../incident-outbox'
import { minuteJobFailingMessage } from '../slack'

/**
 * #2523: a bidding Worker minute job whose runs keep failing still stamps its
 * completion (completeAfter, #985), so its heartbeat reads healthy. Each
 * counted job's failed runs are counted in KV and page past the bound; a run
 * that does not fail clears the count, and the all clear follows once the job
 * has stayed clear for the re-arm window.
 */
const JOB = 'ops-connection-logins'
const MIN = 60_000
const T0 = Date.parse('2026-10-20T13:00:00.000Z')
/** The long dashes, and a hyphen standing alone between spaces, built from char codes. */
const DASH_PUNCTUATION = new RegExp(`[\\u2014\\u2013]|\\s${String.fromCharCode(45)}\\s`)

function memoryKv() {
  const store = new Map<string, string>()
  const ttls = new Map<string, number | undefined>()
  return {
    store,
    ttls,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string, opts?: { expirationTtl?: number }) => { store.set(k, v); ttls.set(k, opts?.expirationTtl) }),
    delete: vi.fn(async (k: string) => { store.delete(k); ttls.delete(k) }),
  }
}
type Kv = ReturnType<typeof memoryKv>

function harness(over: Partial<MinuteJobFailingDeps> & { kv?: Kv } = {}) {
  const kv = over.kv ?? memoryKv()
  let now = T0
  const sendAlert = vi.fn(async () => true)
  const sendRecovery = vi.fn(async () => true)
  const d: MinuteJobFailingDeps = {
    orgsToTell: async () => ['org-one', 'org-two'],
    sendAlert,
    sendRecovery,
    now: () => now,
    ...over,
    kv,
  }
  return {
    d, kv, sendAlert: vi.mocked(over.sendAlert ?? sendAlert), sendRecovery: vi.mocked(over.sendRecovery ?? sendRecovery),
    at: (ms: number) => { now = ms },
  }
}

const FAILED = { failed: true as const, logLine: '[ops-connection-login] check failed:' }
const CLEAN = { failed: false as const }
const marker = (kv: Kv) => kv.store.get(recoveryKey(MINUTE_JOB_FAILING_SIGNAL, JOB))
const outbox = (kv: Kv) => [...kv.store.entries()].filter(([k]) => k.startsWith(INCIDENT_OUTBOX_PREFIX)).map(([, v]) => JSON.parse(v) as { type: string; signal: string; subject: string })

describe('the bound and the signal', () => {
  it('pages at three failed runs in a row', () => {
    expect(MINUTE_JOB_FAILING_BOUND).toBe(3)
  })

  it('has a platform incident signal keyed on the job name, with no window', () => {
    expect(incidentSignal(MINUTE_JOB_FAILING_SIGNAL)).toMatchObject({ scope: 'platform', subject: 'name', windowMinutes: null, label: 'Scheduled job failing' })
  })

  it('counts every minute job of this Worker in the heartbeat registry, and no other', () => {
    for (const job of CRON_JOBS) {
      expect(countsFailedRuns(job.id), job.id).toBe(job.triggerCron === '* * * * *' && job.worker === undefined)
    }
    expect(countsFailedRuns('ops-connection-logins')).toBe(true)
    expect(countsFailedRuns('ops-tick')).toBe(false)
    expect(countsFailedRuns('daily-1300')).toBe(false)
    expect(countsFailedRuns('no-such-job')).toBe(false)
  })
})

describe('recordMinuteJobRun', () => {
  it('pages on the third run of a job that fails every minute, and not before', async () => {
    const h = harness()
    for (let m = 0; m < 2; m++) {
      h.at(T0 + m * MIN)
      const s = await recordMinuteJobRun(h.d, JOB, FAILED)
      expect(s).toMatchObject({ failedRuns: m + 1, paged: false, errors: [] })
    }
    expect(h.sendAlert).not.toHaveBeenCalled()
    expect(marker(h.kv)).toBeUndefined()

    h.at(T0 + 2 * MIN)
    const s = await recordMinuteJobRun(h.d, JOB, FAILED)
    expect(s).toMatchObject({ failedRuns: 3, paged: true, errors: [] })
    expect(h.sendAlert).toHaveBeenCalledTimes(2)
    const [org, alert] = h.sendAlert.mock.calls[0] as unknown as [string, { label: string; failedRuns: number | null; logLine: string; dependents: string }]
    expect(org).toBe('org-one')
    expect(alert).toMatchObject({ label: cronJob(JOB).label, failedRuns: 3, logLine: FAILED.logLine, dependents: cronJob(JOB).dependents })
    // Armed only on delivery, and the page is counted against the incident it opened.
    expect(marker(h.kv)).toBe(new Date(T0 + 2 * MIN).toISOString())
    expect(outbox(h.kv).map((e) => e.type).sort()).toEqual(['opened', 'paged'])
    expect(outbox(h.kv).every((e) => e.signal === MINUTE_JOB_FAILING_SIGNAL && e.subject === JOB)).toBe(true)
  })

  it('keeps failing quietly inside the reminder interval once paged', async () => {
    const h = harness()
    for (let m = 0; m < 10; m++) {
      h.at(T0 + m * MIN)
      await recordMinuteJobRun(h.d, JOB, FAILED)
    }
    // One page round (two organizations), then the reminder schedule holds it.
    expect(h.sendAlert).toHaveBeenCalledTimes(2)
    expect(JSON.parse(h.kv.store.get(failedRunsKey(JOB))!)).toMatchObject({ count: 10 })
  })

  it('renews the count\'s expiry on every failed run while the streak stands', async () => {
    const h = harness()
    await recordMinuteJobRun(h.d, JOB, FAILED)
    h.at(T0 + MIN)
    await recordMinuteJobRun(h.d, JOB, FAILED)
    const puts = h.kv.put.mock.calls.filter(([k]) => k === failedRunsKey(JOB))
    expect(puts).toHaveLength(2)
    for (const [, , opts] of puts) expect(opts?.expirationTtl).toBeGreaterThan(0)
  })

  it('does not page a job that fails once, and a run that does not fail clears its count', async () => {
    const h = harness()
    await recordMinuteJobRun(h.d, JOB, FAILED)
    h.at(T0 + MIN)
    expect(await recordMinuteJobRun(h.d, JOB, CLEAN)).toMatchObject({ failedRuns: 0, paged: false, allClear: false, errors: [] })
    // Never paged, so nothing is owed: the count is gone, and two more failures are still under the bound.
    expect(h.kv.store.has(failedRunsKey(JOB))).toBe(false)
    for (let m = 2; m < 4; m++) {
      h.at(T0 + m * MIN)
      expect((await recordMinuteJobRun(h.d, JOB, FAILED)).paged).toBe(false)
    }
    expect(h.sendAlert).not.toHaveBeenCalled()
    expect(h.sendRecovery).not.toHaveBeenCalled()
  })

  it('reads one key and writes nothing on a clean run with no streak', async () => {
    const h = harness()
    await recordMinuteJobRun(h.d, JOB, CLEAN)
    expect(h.kv.get).toHaveBeenCalledTimes(1)
    expect(h.kv.put).not.toHaveBeenCalled()
    expect(h.kv.delete).not.toHaveBeenCalled()
  })

  it('sends the all clear once the job has run without failing for the re-arm window, and ends the incident', async () => {
    const h = harness()
    for (let m = 0; m < 3; m++) {
      h.at(T0 + m * MIN)
      await recordMinuteJobRun(h.d, JOB, FAILED)
    }
    expect(marker(h.kv)).toBeDefined()
    // The first clean run resets the count but holds the all clear (#814).
    h.at(T0 + 3 * MIN)
    expect(await recordMinuteJobRun(h.d, JOB, CLEAN)).toMatchObject({ failedRuns: 0, allClear: false })
    expect(h.sendRecovery).not.toHaveBeenCalled()
    expect(JSON.parse(h.kv.store.get(failedRunsKey(JOB))!)).toMatchObject({ count: 0 })

    h.at(T0 + 2 * MIN + (RECOVERY_REARM_MINUTES + 1) * MIN)
    const s = await recordMinuteJobRun(h.d, JOB, CLEAN)
    expect(s).toMatchObject({ allClear: true, errors: [] })
    expect(h.sendRecovery).toHaveBeenCalledTimes(2)
    expect(h.sendRecovery.mock.calls[0]).toEqual(['org-one', { label: cronJob(JOB).label, alertedAt: new Date(T0 + 2 * MIN).toISOString(), endedAt: new Date(T0 + 2 * MIN).toISOString() }])
    expect(marker(h.kv)).toBeUndefined()
    expect(h.kv.store.has(failedRunsKey(JOB))).toBe(false)
    expect(outbox(h.kv).map((e) => e.type).sort()).toEqual(['ended', 'opened', 'paged'])

    // A later streak pages again at once: the cooldown went with the incident.
    for (let m = 0; m < 3; m++) {
      h.at(T0 + 60 * MIN + m * MIN)
      await recordMinuteJobRun(h.d, JOB, FAILED)
    }
    expect(h.sendAlert).toHaveBeenCalledTimes(4)
  })

  it('continues the same incident when the job fails again inside the re-arm window', async () => {
    const h = harness()
    for (let m = 0; m < 3; m++) {
      h.at(T0 + m * MIN)
      await recordMinuteJobRun(h.d, JOB, FAILED)
    }
    h.at(T0 + 3 * MIN)
    await recordMinuteJobRun(h.d, JOB, CLEAN)
    for (let m = 4; m < 8; m++) {
      h.at(T0 + m * MIN)
      await recordMinuteJobRun(h.d, JOB, FAILED)
    }
    expect(h.sendAlert).toHaveBeenCalledTimes(2)
    expect(marker(h.kv)).toBe(new Date(T0 + 2 * MIN).toISOString())
    expect(h.sendRecovery).not.toHaveBeenCalled()
  })

  it('pages at once when the count cannot be read, rather than staying quiet', async () => {
    const kv = memoryKv()
    kv.get.mockImplementation(async (k: string) => {
      if (k === failedRunsKey(JOB)) throw new Error('kv read refused')
      return kv.store.get(k) ?? null
    })
    const h = harness({ kv })
    const s = await recordMinuteJobRun(h.d, JOB, FAILED)
    expect(s.paged).toBe(true)
    expect(s.failedRuns).toBeNull()
    const alert = h.sendAlert.mock.calls[0][1] as unknown as { failedRuns: number | null; countFault: string | null }
    expect(alert.failedRuns).toBeNull()
    expect(alert.countFault).toMatch(/could not be read/)
  })

  it('pages at once when the count cannot be kept, since it would never reach the bound', async () => {
    const kv = memoryKv()
    kv.put.mockImplementation(async (k: string, v: string) => {
      if (k === failedRunsKey(JOB)) throw new Error('kv write refused')
      kv.store.set(k, v)
    })
    const h = harness({ kv })
    const s = await recordMinuteJobRun(h.d, JOB, FAILED)
    expect(s.paged).toBe(true)
    expect((h.sendAlert.mock.calls[0][1] as unknown as { countFault: string | null }).countFault).toMatch(/could not be kept/)
  })

  it('pages at once on a count it cannot parse, and keeps counting from the bound', async () => {
    const h = harness()
    h.kv.store.set(failedRunsKey(JOB), 'not a count')
    const s = await recordMinuteJobRun(h.d, JOB, FAILED)
    expect(s.paged).toBe(true)
    expect(JSON.parse(h.kv.store.get(failedRunsKey(JOB))!)).toMatchObject({ count: MINUTE_JOB_FAILING_BOUND })
  })

  it('pages even when the reminder interval cannot be read', async () => {
    const kv = memoryKv()
    kv.get.mockImplementation(async (k: string) => {
      if (k.includes('cooldown')) throw new Error('kv read refused')
      return kv.store.get(k) ?? null
    })
    const h = harness({ kv })
    for (let m = 0; m < 3; m++) {
      h.at(T0 + m * MIN)
      await recordMinuteJobRun(h.d, JOB, FAILED)
    }
    expect(h.sendAlert).toHaveBeenCalled()
  })

  it('holds the all clear, and keeps the count, when the count cannot be read on a clean run', async () => {
    const h = harness()
    for (let m = 0; m < 3; m++) {
      h.at(T0 + m * MIN)
      await recordMinuteJobRun(h.d, JOB, FAILED)
    }
    h.kv.get.mockImplementation(async (k: string) => {
      if (k === failedRunsKey(JOB)) throw new Error('kv read refused')
      return h.kv.store.get(k) ?? null
    })
    h.at(T0 + 60 * MIN)
    const s = await recordMinuteJobRun(h.d, JOB, CLEAN)
    expect(s.allClear).toBe(false)
    expect(s.errors.join(' ')).toMatch(/could not be read/)
    expect(marker(h.kv)).toBeDefined()
  })

  it('arms nothing when no page reached Slack, and tries again on the next failed run', async () => {
    const h = harness({ sendAlert: vi.fn(async () => false) })
    for (let m = 0; m < 3; m++) {
      h.at(T0 + m * MIN)
      await recordMinuteJobRun(h.d, JOB, FAILED)
    }
    expect(marker(h.kv)).toBeUndefined()
    h.at(T0 + 3 * MIN)
    await recordMinuteJobRun(h.d, JOB, FAILED)
    expect(h.sendAlert).toHaveBeenCalledTimes(4)
  })

  it('says nobody could be told when the organization list cannot be read', async () => {
    const h = harness({ orgsToTell: async () => null })
    for (let m = 0; m < 3; m++) {
      h.at(T0 + m * MIN)
      await recordMinuteJobRun(h.d, JOB, FAILED)
    }
    const s = await recordMinuteJobRun(h.d, JOB, FAILED)
    expect(s.paged).toBe(false)
    expect(s.errors.join(' ')).toMatch(/nobody could be told/)
  })

  it('never throws, even for a job the registry does not name', async () => {
    const h = harness()
    const s = await recordMinuteJobRun(h.d, 'no-such-job', FAILED)
    expect(s.paged).toBe(false)
    expect(s.errors.length).toBeGreaterThan(0)
  })
})

describe('makeCompleteAfter', () => {
  function wired() {
    const h = harness()
    const stamps: string[] = []
    const completeAfter = makeCompleteAfter({
      stampCompleted: async (jobId) => { stamps.push(jobId); await h.kv.put(completedKey(jobId), new Date(h.d.now()).toISOString()) },
      failures: h.d,
    })
    return { ...h, stamps, completeAfter }
  }

  it('still stamps the completion of a run that threw, then counts it', async () => {
    const w = wired()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (let m = 0; m < 3; m++) {
      w.at(T0 + m * MIN)
      await w.completeAfter(Promise.reject(new Error('every run fails')), JOB, '[ops-connection-login] check failed:')
    }
    expect(w.stamps).toEqual([JOB, JOB, JOB])
    expect(w.kv.store.get(completedKey(JOB))).toBe(new Date(T0 + 2 * MIN).toISOString())
    expect(w.sendAlert).toHaveBeenCalledTimes(2)
    expect((w.sendAlert.mock.calls[0][1] as unknown as { logLine: string }).logLine).toBe('[ops-connection-login] check failed:')
    expect(console.error).toHaveBeenCalledWith('[ops-connection-login] check failed:', expect.any(Error))
  })

  it('counts a run that reported its own failure through failedRun', async () => {
    const w = wired()
    for (let m = 0; m < 3; m++) {
      w.at(T0 + m * MIN)
      await w.completeAfter(Promise.resolve(failedRun('[ops-connection-login] 1 fault(s)')), JOB)
    }
    expect(w.sendAlert).toHaveBeenCalledTimes(2)
  })

  it('does not count a run that resolved', async () => {
    const w = wired()
    for (let m = 0; m < 5; m++) {
      w.at(T0 + m * MIN)
      await w.completeAfter(Promise.resolve('anything'), JOB)
    }
    expect(w.stamps).toHaveLength(5)
    expect(w.sendAlert).not.toHaveBeenCalled()
  })

  it('stamps and counts nothing for a job that is not a counted minute job', async () => {
    const w = wired()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (let m = 0; m < 5; m++) await w.completeAfter(Promise.reject(new Error('x')), 'daily-1300')
    expect(w.stamps).toHaveLength(5)
    expect(w.kv.store.has(failedRunsKey('daily-1300'))).toBe(false)
    expect(console.error).toHaveBeenCalledWith('[daily-1300] failed past its own handler:', expect.any(Error))
  })

  it('never rejects, even when the completion stamp cannot be written', async () => {
    const h = harness()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const completeAfter = makeCompleteAfter({ stampCompleted: async () => { throw new Error('kv write refused') }, failures: h.d })
    await expect(completeAfter(Promise.reject(new Error('x')), JOB)).resolves.toBeUndefined()
  })
})

describe('the page', () => {
  const alert = { label: cronJob(JOB).label, dependents: cronJob(JOB).dependents, failedRuns: 3, bound: 3, logLine: '[ops-connection-login] check failed:', countFault: null }

  it('names the job, the count, where to look and what clears it, in full sentences with no dash punctuation', () => {
    const m = minuteJobFailingMessage(alert)
    expect(m.title).toBe(`${cronJob(JOB).label} is failing every run`)
    const text = m.sections.join('\n')
    expect(text).toContain('3 runs in a row')
    expect(text).toContain('heartbeat')
    expect(text).toContain('`[ops-connection-login] check failed`')
    expect(text).toMatch(/\*Fix:\*/)
    expect(text).toContain(`${RECOVERY_REARM_MINUTES} minutes`)
    expect(text).not.toMatch(DASH_PUNCTUATION)
    expect(m.title).not.toMatch(DASH_PUNCTUATION)
  })

  it('says the count could not be kept, rather than a number it does not have', () => {
    const m = minuteJobFailingMessage({ ...alert, failedRuns: null, countFault: 'its count of failed runs could not be read' })
    const text = m.sections.join('\n')
    expect(text).not.toMatch(/has failed \d+ runs/)
    expect(text).toContain('could not be read')
    expect(text).toContain('sent at once rather than after 3 failed runs in a row')
  })
})
