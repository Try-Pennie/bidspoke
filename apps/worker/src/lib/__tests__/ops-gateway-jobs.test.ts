/**
 * The heartbeat stamps of the ops jobs other than the tick (#2340, phase 10 of
 * #1689, landing with #2336's sf_limits sweep, its first user):
 * OpsGateway.opsJobStarted and opsJobCompleted.
 *
 * Who may call them: only the ops Worker, over its OPS_GATEWAY service binding
 * to the OpsGateway entrypoint, as every other OpsGateway method (the public
 * edge reaches only the default export, spike P6, and
 * apps/web/src/lib/__tests__/ops-worker-config.test.ts allows the ops Worker
 * exactly that one binding into this Worker). Whose data: none of any
 * organization; each call writes one heartbeat key of one named job.
 *
 * What they accept: only the ids in OPS_GATEWAY_JOBS, each dispatched to one
 * literal stamp (the shape cron-jobs-all-stamped.test.ts requires of a job
 * stamped in lib/ops-gateway.ts), so an id the ops Worker sends that this
 * Worker does not watch is refused by name and writes nothing, and the tick's
 * own id cannot be stamped round its own methods.
 */
import { describe, expect, it, vi } from 'vitest'
import { completedKey, cronJob, evaluateHeartbeat, heartbeatKey } from '../cron-heartbeat'
import { OPS_GATEWAY_JOBS, parseOpsJobId, parseOpsJobReport } from '../ops-gateway-contract'
import { CONNECTION_CHECK_JOB, OPS_TICK_JOB, SF_LIMITS_JOB, recordOpsJobCompleted, recordOpsJobStarted } from '../ops-gateway'

const NOW = Date.parse('2026-10-19T18:00:05.000Z')

function kv() {
  const m = new Map<string, string>()
  return {
    m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => { m.set(k, v) },
    delete: async (k: string) => { m.delete(k) },
  }
}

const report = { started_at: '2026-10-19T18:00:01.000Z', finished_at: '2026-10-19T18:00:04.000Z', counts: { sf_limits_orgs: 1, sf_limits_recorded: 1 } }

describe('the ops job ids', () => {
  it('are the sf_limits and connection_check sweeps, each under the id its heartbeat entry watches', () => {
    expect(OPS_GATEWAY_JOBS).toEqual(['ops-sf-limits', 'ops-connection-check'])
    expect(SF_LIMITS_JOB).toBe('ops-sf-limits')
    expect(CONNECTION_CHECK_JOB).toBe('ops-connection-check')
    for (const job of OPS_GATEWAY_JOBS) expect(cronJob(job).worker).toBe('bidspoke-worker-ops')
  })

  it.each([
    ['the tick\'s own id, which has its own methods', OPS_TICK_JOB],
    ['an id this Worker does not watch', 'ops-owner-check'],
    ['an id of this Worker\'s own crons', 'daily-1300'],
    ['nothing', undefined],
    ['a number', 7],
  ])('refuses %s by name', (_label, raw) => {
    expect(() => parseOpsJobId(raw)).toThrow(/not an ops job this Worker stamps/)
  })

  it('names a long id cut short, so a refusal cannot carry a payload into the logs', () => {
    expect(() => parseOpsJobId('x'.repeat(500))).toThrow(/^(?!.*x{100})/)
  })
})

describe('parseOpsJobReport', () => {
  it('reads a report of times and counts', () => {
    expect(parseOpsJobReport(report)).toEqual(report)
  })

  it.each([
    ['not an object', 'done'],
    ['an unreadable start', { ...report, started_at: 'soon' }],
    ['counts that are not numbers', { ...report, counts: { sf_limits_orgs: 'one' } }],
    ['a count that is not finite', { ...report, counts: { sf_limits_orgs: Number.NaN } }],
  ])('refuses one that is %s', (_label, raw) => {
    expect(() => parseOpsJobReport(raw)).toThrow()
  })
})

describe('recordOpsJobStarted', () => {
  it.each(OPS_GATEWAY_JOBS)('stamps %s\'s own started key on this Worker\'s clock, and no other', async (job) => {
    const store = kv()
    expect(await recordOpsJobStarted(store as unknown as KVNamespace, job, NOW)).toBe(job)
    expect(store.m.get(heartbeatKey(job))).toBe(new Date(NOW).toISOString())
    expect(store.m.size).toBe(1)
  })

  it('writes nothing for an id it refuses', async () => {
    const store = kv()
    await expect(recordOpsJobStarted(store as unknown as KVNamespace, OPS_TICK_JOB, NOW)).rejects.toThrow(/not an ops job/)
    await expect(recordOpsJobStarted(store as unknown as KVNamespace, 'ops-owner-check', NOW)).rejects.toThrow(/not an ops job/)
    expect(store.m.size).toBe(0)
  })
})

describe('recordOpsJobCompleted', () => {
  it.each(OPS_GATEWAY_JOBS)('stamps %s\'s own completed key, and no other', async (job) => {
    const store = kv()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      expect(await recordOpsJobCompleted(store as unknown as KVNamespace, job, report, NOW)).toBe(job)
    } finally {
      log.mockRestore()
    }
    expect(store.m.get(completedKey(job))).toBe(new Date(NOW).toISOString())
    expect(store.m.size).toBe(1)
  })

  it('stamps the job\'s completed key, and logs the report by name', async () => {
    const store = kv()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await recordOpsJobCompleted(store as unknown as KVNamespace, SF_LIMITS_JOB, report, NOW)
      expect(store.m.get(completedKey(SF_LIMITS_JOB))).toBe(new Date(NOW).toISOString())
      expect(log.mock.calls.map((c) => JSON.parse(String(c[0])))).toEqual([{ event: 'ops_job_completed', job: SF_LIMITS_JOB, ...report.counts }])
    } finally {
      log.mockRestore()
    }
  })

  // The run did finish: the stamp is about finishing, and a report this Worker
  // cannot read must not make the heartbeat call a finished run killed.
  it('still stamps completed for a report it cannot read, and says so in an error line', async () => {
    const store = kv()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await recordOpsJobCompleted(store as unknown as KVNamespace, SF_LIMITS_JOB, { counts: 'all of them' }, NOW)
      expect(store.m.get(completedKey(SF_LIMITS_JOB))).toBe(new Date(NOW).toISOString())
      expect(JSON.parse(String(error.mock.calls[0][0]))).toMatchObject({ event: 'ops_job_report_unreadable', job: SF_LIMITS_JOB })
    } finally {
      error.mockRestore()
    }
  })

  it('writes nothing for an id it refuses', async () => {
    const store = kv()
    await expect(recordOpsJobCompleted(store as unknown as KVNamespace, OPS_TICK_JOB, report, NOW)).rejects.toThrow(/not an ops job/)
    expect(store.m.size).toBe(0)
  })
})

describe('the ops-sf-limits heartbeat (#2340)', () => {
  const job = cronJob(SF_LIMITS_JOB)
  const iso = (ms: number) => new Date(ms).toISOString()
  const MIN = 60_000

  it('is watched from this Worker on the ops minute trigger', () => {
    expect(job.worker).toBe('bidspoke-worker-ops')
    expect(job.triggerCron).toBe('* * * * *')
  })

  it('outlasts the tick\'s own heartbeat by at least one sweep interval, so a dark tick pages as the tick and not as the sweep', () => {
    expect(job.staleMs).toBeGreaterThanOrEqual(cronJob(OPS_TICK_JOB).staleMs + 5 * MIN)
  })

  it('pages as never ran when the sweep never stamps after its entry is first seen (a deploy that does not carry it)', () => {
    expect(evaluateHeartbeat(null, iso(NOW - job.staleMs - 1), NOW, job.staleMs).status).toBe('never_ran')
    expect(evaluateHeartbeat(null, iso(NOW - job.staleMs + MIN), NOW, job.staleMs).status).toBe('pending')
  })

  it('pages as stale when the sweep stops stamping its start', () => {
    const v = evaluateHeartbeat(iso(NOW - job.staleMs - 1), iso(NOW - 10 * job.staleMs), NOW, job.staleMs, iso(NOW - job.staleMs), job.maxRunMs, iso(NOW - 10 * job.staleMs), job.completionDroughtMs ?? null)
    expect(v.status).toBe('stale')
  })

  it('is healthy across one missed completion, and pages as vanished when starts go on and nothing finishes for the drought', () => {
    const watching = iso(NOW - 10 * job.staleMs)
    // Started 4 minutes ago, last finished 8 minutes ago: one completion stamp lost.
    expect(evaluateHeartbeat(iso(NOW - 4 * MIN), watching, NOW, job.staleMs, iso(NOW - 8 * MIN), job.maxRunMs, watching, job.completionDroughtMs ?? null).status).toBe('healthy')
    const quiet = (job.completionDroughtMs ?? 0) + MIN
    expect(evaluateHeartbeat(iso(NOW - 2 * MIN), watching, NOW, job.staleMs, iso(NOW - quiet), job.maxRunMs, watching, job.completionDroughtMs ?? null).status).toBe('vanished')
  })

  it('judges completions by a drought of at least three sweeps, short of the stale verdict', () => {
    expect(job.completionDroughtMs).toBeGreaterThanOrEqual(3 * 5 * MIN)
    expect(job.completionDroughtMs).toBeLessThan(job.staleMs)
  })
})

describe('the ops-connection-check heartbeat (#2340)', () => {
  const job = cronJob(CONNECTION_CHECK_JOB)
  const iso = (ms: number) => new Date(ms).toISOString()
  const MIN = 60_000
  // The sweep is claimed every 14 minutes, so it runs every 14 or 15, or 16 with a missed tick.
  const SWEEP_MAX_MS = 16 * MIN

  it('is watched from this Worker on the ops minute trigger', () => {
    expect(job.worker).toBe('bidspoke-worker-ops')
    expect(job.triggerCron).toBe('* * * * *')
  })

  it('outlasts the tick\'s own heartbeat by at least one sweep interval with a missed tick, so a dark tick pages as the tick', () => {
    expect(job.staleMs).toBeGreaterThanOrEqual(cronJob(OPS_TICK_JOB).staleMs + SWEEP_MAX_MS)
  })

  it('pages as never ran when the sweep never stamps after its entry is first seen', () => {
    expect(evaluateHeartbeat(null, iso(NOW - job.staleMs - 1), NOW, job.staleMs).status).toBe('never_ran')
    expect(evaluateHeartbeat(null, iso(NOW - job.staleMs + MIN), NOW, job.staleMs).status).toBe('pending')
  })

  it('pages as stale when the sweep stops stamping its start while the tick runs on', () => {
    const v = evaluateHeartbeat(iso(NOW - job.staleMs - 1), iso(NOW - 10 * job.staleMs), NOW, job.staleMs, iso(NOW - job.staleMs), job.maxRunMs, iso(NOW - 10 * job.staleMs), job.completionDroughtMs ?? null)
    expect(v.status).toBe('stale')
  })

  it('is healthy across two missed completions, and pages as vanished when starts go on and nothing finishes for three sweeps', () => {
    const watching = iso(NOW - 10 * job.staleMs)
    expect(evaluateHeartbeat(iso(NOW - 2 * MIN), watching, NOW, job.staleMs, iso(NOW - 2 * SWEEP_MAX_MS), job.maxRunMs, watching, job.completionDroughtMs ?? null).status).toBe('healthy')
    const quiet = (job.completionDroughtMs ?? 0) + MIN
    expect(evaluateHeartbeat(iso(NOW - 2 * MIN), watching, NOW, job.staleMs, iso(NOW - quiet), job.maxRunMs, watching, job.completionDroughtMs ?? null).status).toBe('vanished')
  })

  it('judges completions by a drought of three sweeps at their usual spacing, short of the stale verdict', () => {
    expect(job.completionDroughtMs).toBeGreaterThanOrEqual(3 * 15 * MIN)
    expect(job.completionDroughtMs).toBeLessThan(job.staleMs)
  })
})
