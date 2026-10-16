/**
 * Guard: the drain of stored Salesforce writes is started by the minute cron, as
 * a minute job (#468 step 3).
 *
 * The drain's bound against the backlog alert (writeback-drain-schedule.test.ts
 * in the worker) is computed from a one minute tick and the minute job deadline.
 * Moved to a slower cron, or started outside minuteJob, the drain could keep a
 * row past the alert's 30 minutes while still working, and the page would call
 * that a write nobody handled. The heartbeat stamps are cron-jobs-all-stamped's.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WORKER_SRC } from '../../__tests__/_scan-utils'

const INDEX = readFileSync(path.join(WORKER_SRC, 'index.ts'), 'utf8')

/** The source of the branch the handler runs for one cron expression, up to the next branch. */
export function cronBranch(source: string, cron: string): string {
  const start = source.indexOf(`event.cron === '${cron}'`)
  if (start < 0) return ''
  const next = source.indexOf('event.cron ===', start + 1)
  return source.slice(start, next < 0 ? undefined : next)
}

describe('the stored writes drain runs every minute', () => {
  it('is a minute job of the minute cron that runs the drain', () => {
    expect(cronBranch(INDEX, '* * * * *')).toMatch(/minuteJob\('writeback-drain',\s*completeAfter\([\s\S]{0,600}runWritebackDrainForEnv\(/)
  })

  it('is started by no other cron', () => {
    for (const cron of ['*/5 * * * *', '*/15 * * * *', '0 * * * *']) expect(cronBranch(INDEX, cron), cron).not.toMatch(/runWritebackDrainForEnv/)
  })

  it('reads a branch by its cron, so a drain moved to another cron is seen', () => {
    const src = "if (event.cron === '* * * * *') { minuteJob('a') } else if (event.cron === '*/5 * * * *') { runWritebackDrainForEnv() }"
    expect(cronBranch(src, '* * * * *')).not.toMatch(/runWritebackDrainForEnv/)
    expect(cronBranch(src, '*/5 * * * *')).toMatch(/runWritebackDrainForEnv/)
  })
})
