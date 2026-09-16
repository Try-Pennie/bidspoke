import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * The worker's GitHub workflow dispatcher runs every 15 minutes (#1368).
 *
 * The dispatcher reads each workflow's run history before deciding to start it.
 * When GitHub refuses that read (a request limit used up on the account that owns
 * the token), the dispatcher does nothing for that tick. On an hourly cron that
 * cost a whole hour of Deploy Drift, twice on 2026-09-16. Every 15 minutes, a
 * refused read is simply tried again a quarter hour later, with nothing stored in
 * between.
 *
 * Three places have to agree, and nothing but this test ties them together: the
 * cron branch in index.ts that calls the dispatcher, the tick length the driver's
 * headroom guard reasons in, and the cron actually registered in wrangler.toml.
 * Lives in apps/web because apps/worker has no node filesystem types.
 */
const read = (relative: string): string => {
  const text = readFileSync(path.join(REPO_ROOT, relative), 'utf8')
  expect(text.length, `${relative} is empty`).toBeGreaterThan(0)
  return text
}

const CADENCE = '*/15 * * * *'

describe('the workflow dispatcher cadence (#1368)', () => {
  it('is called from the every-15-minutes cron branch, and only there', () => {
    const index = read('apps/worker/src/index.ts')
    const calls = [...index.matchAll(/runAndReportDispatch\(/g)]
    expect(calls.length, 'the scheduled handler should call the dispatcher exactly once').toBe(1)
    const before = index.slice(0, calls[0].index)
    const branches = [...before.matchAll(/event\.cron === '([^']+)'/g)]
    expect(branches.length, 'no cron branch found above the dispatcher call').toBeGreaterThan(0)
    expect(branches[branches.length - 1][1]).toBe(CADENCE)
  })

  it('declares a tick length that matches that cron', () => {
    const driver = read('apps/worker/src/lib/workflow-dispatch-driver.ts')
    const expr = driver.match(/export const DRIVE_TICK_MS = ([\d\s*]+)\n/)?.[1]
    expect(expr, 'DRIVE_TICK_MS is no longer a plain product of numbers').toBeDefined()
    const ms = expr!
      .split('*')
      .map((n) => Number(n.trim()))
      .reduce((a, b) => a * b, 1)
    expect(ms).toBe(15 * 60 * 1000)
  })

  it('runs on a cron wrangler actually registers', () => {
    const crons = read('apps/worker/wrangler.toml').match(/^crons = \[([^\]]+)\]/m)?.[1] ?? ''
    expect(crons).toContain(`"${CADENCE}"`)
  })
})
