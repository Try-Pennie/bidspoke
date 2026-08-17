import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../../__tests__/_scan-utils'
import { sanitizeSource } from '../../__tests__/_scan-utils'

/**
 * Every cron Cloudflare is told to fire must have a handler, and every handler
 * must have a cron.
 *
 * The schedule lives in `apps/worker/wrangler.toml` and the dispatch lives in a
 * chain of `event.cron === '...'` comparisons in `apps/worker/src/index.ts`. The
 * two are coupled only by an exact string, in different files and different
 * languages, so editing one and not the other is silent in both directions:
 *
 *   cron with no branch    Cloudflare fires it, nothing runs, and a scheduled
 *                          invocation that does nothing looks identical to one
 *                          that had no work to do.
 *   branch with no cron    the handler is dead and the job simply never happens,
 *                          which is indistinguishable from a job that keeps
 *                          finding nothing wrong.
 *
 * Added while moving the daily timeout audit off peak (#251), which is precisely
 * an edit that has to land in both files at once. LESSONS L3: built is not wired,
 * and wired is not proven.
 */
const WRANGLER = path.join(REPO_ROOT, 'apps/worker/wrangler.toml')
const INDEX = path.join(REPO_ROOT, 'apps/worker/src/index.ts')
const HEARTBEAT = path.join(REPO_ROOT, 'apps/worker/src/lib/cron-heartbeat.ts')

/** The cron expressions wrangler.toml schedules. */
export function scheduledCrons(toml: string): string[] {
  // Ignore commented-out lines so a disabled schedule is not read as live.
  const live = toml
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')
  const block = /crons\s*=\s*\[([^\]]*)\]/.exec(live)
  if (!block) return []
  return [...block[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1])
}

/** The cron expressions index.ts dispatches on. */
export function handledCrons(src: string): string[] {
  // Comments stripped, string contents kept, so a cron named in prose is not
  // mistaken for a live branch.
  const scrubbed = sanitizeSource(src, { blankStrings: false })
  return [...scrubbed.matchAll(/event\.cron\s*===\s*["']([^"']+)["']/g)].map((m) => m[1])
}

/**
 * The cron each heartbeat job claims to be driven by. A third copy of the same
 * string, in a third file: the heartbeat declares a job dark when its marker goes
 * stale, so a `triggerCron` naming a schedule that no longer exists describes a
 * job nobody is really watching.
 */
export function heartbeatCrons(src: string): string[] {
  const scrubbed = sanitizeSource(src, { blankStrings: false })
  return [...scrubbed.matchAll(/triggerCron:\s*["']([^"']+)["']/g)].map((m) => m[1])
}

const crons = scheduledCrons(readFileSync(WRANGLER, 'utf8'))
const handled = handledCrons(readFileSync(INDEX, 'utf8'))
const heartbeats = heartbeatCrons(readFileSync(HEARTBEAT, 'utf8'))

describe('worker cron wiring (#251)', () => {
  it('has a handler for every scheduled cron', () => {
    expect(crons.filter((c) => !handled.includes(c)), 'scheduled but nothing runs').toEqual([])
  })

  it('has a schedule for every handled cron', () => {
    expect(handled.filter((c) => !crons.includes(c)), 'handled but never fires').toEqual([])
  })

  it('has a real schedule behind every heartbeat job', () => {
    // A heartbeat watching a cron that no longer fires reports the job dark
    // forever, or worse, is quietly never evaluated.
    expect(heartbeats.filter((c) => !crons.includes(c)), 'heartbeat names a cron that is not scheduled').toEqual([])
  })

  it('read all three files, so it cannot pass vacuously', () => {
    expect(crons.length).toBeGreaterThan(3)
    expect(handled.length).toBeGreaterThan(3)
    expect(heartbeats.length).toBeGreaterThan(2)
  })

  it('parses a heartbeat triggerCron', () => {
    expect(heartbeatCrons("triggerCron: '0 9 * * *',")).toEqual(['0 9 * * *'])
  })

  it('parses a crons array', () => {
    expect(scheduledCrons('crons = ["0 9 * * *", "* * * * *"]')).toEqual(['0 9 * * *', '* * * * *'])
  })

  it('ignores a commented-out schedule', () => {
    expect(scheduledCrons('# crons = ["0 3 * * *"]\ncrons = ["0 9 * * *"]')).toEqual(['0 9 * * *'])
  })

  it('parses a dispatch branch', () => {
    expect(handledCrons("if (event.cron === '0 9 * * *') {")).toEqual(['0 9 * * *'])
  })

  it('does not treat a cron mentioned in a comment as handled', () => {
    expect(handledCrons("// used to be event.cron === '0 13 * * *'\nconst x = 1")).toEqual([])
  })
})
