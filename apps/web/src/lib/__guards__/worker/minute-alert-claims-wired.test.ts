import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WORKER_SRC, consumeParens, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

/**
 * The minute alert claims (#2062, #1303 phase 4) are taken by the minute alerts
 * and only by them, and the scheduled handler hands each of them its claims.
 *
 * Both halves fail silently. A minute alert started without its claims posts
 * twice when a stalled tick overlaps the next minute's, and reads as working on
 * every quiet day (L3: built is not wired). A daily or hourly check given one
 * makes a Durable Object call per tick for a race that cannot happen, since its
 * ticks never overlap; alert-fanout.ts records why.
 *
 * The claiming modules are DERIVED from the worker's source (whoever calls
 * postMinutePage, claimMinutePage or minuteAllClearClaim), and compared both ways with the list
 * below, so a new claimant cannot be added without saying which run function it
 * is started by (L96).
 */
const LIB = path.join(WORKER_SRC, 'lib')
const INDEX = path.join(WORKER_SRC, 'index.ts')

/** Each claiming module and the functions the scheduled handler starts it with. */
const MINUTE_CLAIMANTS: Record<string, string[]> = {
  'failure-rate.ts': ['runFailureRateCheck'],
  'slow-execution-rate.ts': ['runSlowExecutionCheck'],
  'upstream-outage.ts': ['runUpstreamOutageCheck'],
  // #2582: the partner ping failure page, judged every minute like the rate checks above.
  'partner-error-rate.ts': ['runPartnerErrorRateCheck'],
  'cron-heartbeat.ts': ['runHeartbeatChecks'],
  'database-reachability.ts': ['runDatabaseReachabilityProbe', 'reportDatabaseUnreachable'],
  // #2331: the sealed Slack token page, judged by the minute probe from the rows
  // it reads, with the probe's claims.
  'slack-token-health.ts': ['runDatabaseReachabilityProbe'],
  // #2340: the ops connection login page, judged every minute from the ops
  // tick's kept report, so two overlapping ticks could both post it.
  // #2340 phase 10 item 4: the write back page, judged every minute from the
  // judgement the bidding Worker keeps, so the same holds.
  'ops-connection-logins.ts': ['runOpsConnectionLoginCheckForEnv', 'runOpsConnectionWriteBackCheckForEnv'],
  // #2523: the failing minute job page, judged as each minute job's run settles
  // inside completeAfter, so two overlapping ticks could both post it.
  'minute-job-failures.ts': ['minuteJobFailingDepsForEnv'],
}

/**
 * The calls allowed outside the minute branch, and why. Every scheduled tick's
 * first failed read reports to the database owner (#2061), so the owner is
 * told from any tick; its page is a minute alert all the same, since the minute
 * probe and the volume check report to it every minute. completeAfter is built
 * once for every tick with the failing scheduled job page's deps (#2523). It
 * counts the minute jobs and, since #2526, the five minute, fifteen minute and
 * hourly ones too (countsFailedRuns), so its claims are also taken on those
 * ticks, but only when a page or an all clear is about to be sent, never on an
 * ordinary run, and a duplicate delivery of one of those ticks (#1904) is the
 * race they stop.
 */
const ANY_TICK = new Set(['reportDatabaseUnreachable', 'minuteJobFailingDepsForEnv'])

/**
 * Modules outside the scheduled handler that hand announceRecovery a claim, and
 * why. Their all clear is decided inside lead runs, which arrive at the lead rate
 * in many isolates at once, so two runs judging the same incident over is the
 * ordinary case, not a stalled tick. The claim is still asked only once an all
 * clear is owed (announceRecovery's own order), so a quiet run makes no call.
 */
const LEAD_RUN_CLAIMANTS: Record<string, string> = {
  // #2589: a lead validation step reading its settings whole again.
  'lead-validation-config-alert.ts': 'reported from every lead run that passes a lead validation step',
}

const sources = new Map(
  listTsFiles(LIB)
    .filter((f) => !f.replace(/\\/g, '/').includes('/__tests__/'))
    .map((f) => [path.basename(f), sanitizeSource(readFileSync(f, 'utf8'), { blankStrings: false })] as const),
)

const index = sanitizeSource(readFileSync(INDEX, 'utf8'), { blankStrings: false })

/** The span of the `{ ... }` block opening at the first `{` at or after `from`, braces matched. */
function braceBlock(src: string, from: number, what: string): { start: number; end: number } {
  const open = src.indexOf('{', from)
  let depth = 0
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}' && --depth === 0) return { start: open, end: k }
  }
  throw new Error(`${what} does not close`)
}

/** The `{ ... }` body of the minute cron's branch in the scheduled handler. */
function minuteBranch(src: string): { start: number; end: number } {
  const at = src.search(/event\.cron\s*===\s*'\* \* \* \* \*'\s*\)\s*\{/)
  if (at < 0) throw new Error('the minute cron branch was not found in index.ts')
  return braceBlock(src, at, 'the minute cron branch')
}

/** Every call of `name` in index.ts (not its import), with its argument text. */
function callsOf(src: string, name: string): { at: number; args: string }[] {
  return [...src.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))].map((m) => {
    const open = m.index! + m[0].length - 1
    return { at: m.index!, args: src.slice(open, consumeParens(src, open)) }
  })
}

const reachabilityLiteral = (() => {
  const at = index.search(/const reachability\s*=\s*\{/)
  if (at < 0) return ''
  const block = braceBlock(index, at, 'the reachability literal')
  return index.slice(block.start, block.end + 1)
})()

/** The owner's claims are the real claim object whenever the binding exists. */
const reachabilityHasClaims = /\bclaims:\s*env\.ALERT_CLAIM\s*\?\s*makeAlertClaims\(env\.ALERT_CLAIM\)/.test(reachabilityLiteral)

describe('the minute alert claims are wired to the minute alerts only (#2062)', () => {
  it('the modules that claim are exactly the minute alerts listed here', () => {
    const claiming = [...sources.entries()]
      // claimMinutePage is postMinutePage's claim half, for a page several jobs share (#2117).
      .filter(([file, src]) => file !== 'alert-fanout.ts' && /\b(?:postMinutePage|claimMinutePage|minuteAllClearClaim)\s*\(/.test(src))
      .map(([file]) => file)
      .sort()
    expect(claiming).toEqual(Object.keys(MINUTE_CLAIMANTS).sort())
  })

  it('no other module hands announceRecovery a claim', () => {
    // Every announceRecovery call outside the minute alerts, read by its own
    // arguments, so a claim built in a variable is caught as well as a literal.
    const claimingCalls = [...sources.entries()]
      .filter(([file]) => !(file in MINUTE_CLAIMANTS) && !(file in LEAD_RUN_CLAIMANTS) && file !== 'alert-recovery.ts')
      .flatMap(([file, src]) => callsOf(src, 'announceRecovery').filter((c) => /\bclaim\s*:/.test(c.args)).map(() => file))
    expect(claimingCalls).toEqual([])
  })

  const branch = minuteBranch(index)
  for (const [file, fns] of Object.entries(MINUTE_CLAIMANTS)) {
    for (const fn of fns) {
      it(`${fn} (${file}) is started only on the minute cron, with its claims`, () => {
        const calls = callsOf(index, fn)
        expect(calls.length, `${fn} is never called in index.ts`).toBeGreaterThan(0)
        for (const c of calls) {
          const inMinute = c.at > branch.start && c.at < branch.end
          if (!ANY_TICK.has(fn)) expect(inMinute, `${fn} is called outside the minute cron branch`).toBe(true)
          // The claims are the owner's (`reachability.claims`), passed by name, by
          // spreading `reachability`, or as `reachability` itself (the owner's
          // deps); a bare `claims` word could be anything.
          const hasClaims = (/\breachability\.claims\b/.test(c.args) || /\.\.\.reachability\b/.test(c.args) || /^\(\s*reachability\s*,/.test(c.args)) && reachabilityHasClaims
          expect(hasClaims, `${fn}${c.args.replace(/\s+/g, ' ')} is not handed its claims`).toBe(true)
        }
      })
    }
  }
})
