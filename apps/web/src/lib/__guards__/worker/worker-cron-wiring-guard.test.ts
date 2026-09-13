import { readFileSync, readdirSync } from 'node:fs'
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
 * The job ids the heartbeat registry watches.
 *
 * A job listed here is watched; a job with no `writeHeartbeat` call is watched
 * and CANNOT report, which is not the same as a job that is broken and is
 * reported in exactly the same words (#1332). PR #1324 registered the archive's
 * 13 month expiry and never stamped it: it ran and finished for two days while
 * the switch alerted every six hours that it had never run, and pointed the
 * reader at cron triggers that were correct. Registering a subject in a
 * monitor's list is only half the change; it must also be instrumented.
 */
export function heartbeatJobIds(src: string): string[] {
  const scrubbed = sanitizeSource(src, { blankStrings: false })
  return [...scrubbed.matchAll(/^\s*id:\s*["']([^"']+)["']/gm)].map((m) => m[1])
}

/**
 * The job ids the scheduled handler actually stamps.
 *
 * An id reaches `writeHeartbeat` either as a literal or through an exported
 * constant, so both are resolved: the constants are read from the worker's own
 * source rather than listed here, because a hand kept list of them would be the
 * same class of defect one level up (L96).
 */
export function stampedJobIds(indexSrc: string, constants: Map<string, string>): string[] {
  const scrubbed = sanitizeSource(indexSrc, { blankStrings: false })
  const ids: string[] = []
  for (const m of scrubbed.matchAll(/writeHeartbeat\s*\(\s*[^,)]+,\s*(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))/g)) {
    const literal = m[1]
    const viaConst = m[2] ? constants.get(m[2]) : undefined
    if (literal) ids.push(literal)
    else if (viaConst) ids.push(viaConst)
  }
  return ids
}

/** Every `export const NAME = 'value'` in the worker's lib, for the above. */
export function exportedStringConstants(sources: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const src of sources) {
    for (const m of src.matchAll(/export const ([A-Z][A-Z0-9_]*)\s*=\s*["']([^"']+)["']/g)) {
      out.set(m[1], m[2])
    }
  }
  return out
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

const LIB = path.join(REPO_ROOT, 'apps/worker/src/lib')

const indexSrc = readFileSync(INDEX, 'utf8')
const crons = scheduledCrons(readFileSync(WRANGLER, 'utf8'))
const handled = handledCrons(indexSrc)
const heartbeats = heartbeatCrons(readFileSync(HEARTBEAT, 'utf8'))
const jobIds = heartbeatJobIds(readFileSync(HEARTBEAT, 'utf8'))
const constants = exportedStringConstants(
  readdirSync(LIB)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(path.join(LIB, f), 'utf8')),
)
const stamped = stampedJobIds(indexSrc, constants)

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

  it('stamps a heartbeat for every job it watches (#1332)', () => {
    // Watched but never stamped is permanently indistinguishable from broken,
    // and the remedy the alert gives names something that was never wrong.
    expect(jobIds.filter((id) => !stamped.includes(id)), 'watched but nothing stamps it').toEqual([])
  })

  it('does not stamp a job it never registered', () => {
    // The other direction: a stamp for an id the registry does not hold writes
    // to a key nothing reads, so the job looks watched and is not.
    expect(stamped.filter((id) => !jobIds.includes(id)), 'stamped but not watched').toEqual([])
  })

  it('read all four files, so it cannot pass vacuously', () => {
    expect(crons.length).toBeGreaterThan(3)
    expect(handled.length).toBeGreaterThan(3)
    expect(heartbeats.length).toBeGreaterThan(2)
    expect(jobIds.length).toBeGreaterThan(5)
    expect(stamped.length).toBeGreaterThan(5)
    expect(constants.size).toBeGreaterThan(5)
  })

  it('parses a job id out of the registry', () => {
    expect(heartbeatJobIds("  {\n    id: 'daily-1300',\n    label: 'x',")).toEqual(['daily-1300'])
  })

  it('reads a stamp written with a literal and one written through a constant', () => {
    const consts = new Map([['ARCHIVE_EXPIRY_JOB', 'execution-archive-expiry']])
    expect(stampedJobIds("writeHeartbeat(env.IDEMPOTENCY, 'daily-1300')", consts)).toEqual(['daily-1300'])
    expect(stampedJobIds('writeHeartbeat(env.IDEMPOTENCY, ARCHIVE_EXPIRY_JOB)', consts)).toEqual([
      'execution-archive-expiry',
    ])
  })

  it('does not read a job id out of a comment', () => {
    expect(heartbeatJobIds("// id: 'ghost-job'\nconst x = 1")).toEqual([])
    expect(stampedJobIds("// writeHeartbeat(env.IDEMPOTENCY, 'ghost-job')", new Map())).toEqual([])
  })

  it('collects exported string constants from source', () => {
    expect(exportedStringConstants(["export const ARCHIVE_EXPIRY_JOB = 'execution-archive-expiry'"])).toEqual(
      new Map([['ARCHIVE_EXPIRY_JOB', 'execution-archive-expiry']]),
    )
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
