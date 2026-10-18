/**
 * The Tripoint tripoint_ping outcome rate bridge (#2392) is wired: the 15 minute
 * branch of the scheduled handler runs it under both heartbeat stamps, and the
 * heartbeat registry watches it on that same cadence (L3: built is not wired).
 *
 * The bridge is retired in the #1414 change that removes tripoint_ping; delete
 * this guard with it.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WORKER_SRC } from '../../__tests__/_scan-utils'

const INDEX = readFileSync(path.join(WORKER_SRC, 'index.ts'), 'utf8')
const REGISTRY = readFileSync(path.join(WORKER_SRC, 'lib/cron-heartbeat.ts'), 'utf8')

/** The body of the `event.cron === '<cron>'` branch, up to the next branch. */
export function cronBranch(source: string, cron: string): string | null {
  const head = source.indexOf(`event.cron === '${cron}'`)
  if (head < 0) return null
  const next = source.indexOf('} else if (event.cron', head + 1)
  return source.slice(head, next < 0 ? undefined : next)
}

/** The registry entry for a job id, as written. */
export function registryEntry(source: string, id: string): string | null {
  const at = source.indexOf(`id: '${id}',`)
  if (at < 0) return null
  const end = source.indexOf('\n  },', at)
  return source.slice(at, end < 0 ? undefined : end)
}

describe('the tripoint_ping outcome rate bridge is wired (#2392)', () => {
  it('runs in the 15 minute branch, stamped started and completed under its own job name', () => {
    const branch = cronBranch(INDEX, '*/15 * * * *')
    expect(branch, 'no */15 branch in the scheduled handler').not.toBeNull()
    // The one completeAfter block that runs the bridge must itself carry both
    // stamps, so a stamp in a neighbouring block cannot stand in for it.
    const blocks = (branch ?? '').split('completeAfter(').slice(1)
    const own = blocks.filter((b) => b.includes('runTripointPingOutcomeRateForEnv(supabase, env)'))
    expect(own, 'the bridge must run inside exactly one completeAfter block of the */15 branch').toHaveLength(1)
    expect(own[0]).toMatch(/^\s*writeHeartbeat\(env\.IDEMPOTENCY, TRIPOINT_PING_OUTCOME_RATE_JOB\)/)
    // The settled stamp: the job argument that closes this completeAfter call.
    expect(/(\w+_JOB),\s*\),\s*\)/.exec(own[0])?.[1]).toBe('TRIPOINT_PING_OUTCOME_RATE_JOB')
  })

  it('does not accept a stamp from a neighbouring block', () => {
    const src = "event.cron === '*/15 * * * *'\n completeAfter(\n writeHeartbeat(env.IDEMPOTENCY, OTHER_JOB)\n .then(() => runTripointPingOutcomeRateForEnv(supabase, env)),\n OTHER_JOB,\n ),\n )\n completeAfter(\n writeHeartbeat(env.IDEMPOTENCY, TRIPOINT_PING_OUTCOME_RATE_JOB),\n TRIPOINT_PING_OUTCOME_RATE_JOB,\n ),\n )\n"
    const own = (cronBranch(src, '*/15 * * * *') ?? '').split('completeAfter(').slice(1).filter((b) => b.includes('runTripointPingOutcomeRateForEnv(supabase, env)'))
    expect(own).toHaveLength(1)
    expect(own[0]).not.toMatch(/^\s*writeHeartbeat\(env\.IDEMPOTENCY, TRIPOINT_PING_OUTCOME_RATE_JOB\)/)
  })

  it('is watched by the heartbeat registry on the cadence it runs at', () => {
    const entry = registryEntry(REGISTRY, 'tripoint-ping-outcome-rate')
    expect(entry, 'tripoint-ping-outcome-rate is not in CRON_JOBS').not.toBeNull()
    expect(entry).toContain("triggerCron: '*/15 * * * *'")
    expect(entry).toMatch(/staleMs: 45 \* MIN/)
  })

  it('reads the branch it names, not the whole handler', () => {
    const src = "if (event.cron === '*/15 * * * *') {\n  a()\n} else if (event.cron === '* * * * *') {\n  runTripointPingOutcomeRateForEnv(supabase, env)\n}"
    expect(cronBranch(src, '*/15 * * * *')).not.toContain('runTripointPingOutcomeRateForEnv')
    expect(cronBranch(src, '* * * * *')).toContain('runTripointPingOutcomeRateForEnv')
  })
})
