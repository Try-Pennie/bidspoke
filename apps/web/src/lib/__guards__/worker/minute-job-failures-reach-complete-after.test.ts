/**
 * Guard: a counted job stamped through completeAfter hands its failures to
 * completeAfter, so its failed runs are counted and page (#2523, #2526).
 *
 * completeAfter counts a run as failed when the job's work rejects (or resolves
 * to failedRun()). A job whose work ends in its own `.catch(...)` swallows every
 * throw before completeAfter sees it, and then fails every run while reading
 * healthy, which is the defect #2523 fixed for the minute jobs and #2526 for the
 * five minute, fifteen minute and hourly ones. A counted job is one of this
 * Worker in CRON_JOBS whose cron is a key of FAILED_RUN_CADENCES in
 * minute-job-failures.ts, read from that source here, so a cadence added there
 * is held to this at once. For every completeAfter call in index.ts whose job is
 * counted, this refuses a work argument whose last step is a `.catch`, and
 * requires the job's own failure line as the third argument, which
 * completeAfter logs in place of the swallowed log line.
 *
 * Read with the TypeScript parser, by each call's own arguments (#2522).
 * Seen to fail with the `.catch` put back on ops-connection-logins' work, with
 * buyer-sale-drain's failure line removed, with the `.catch` put back on
 * engine-script-drift's work, and with the hourly cadence removed from
 * FAILED_RUN_CADENCES.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { WORKER_SRC, listTsFiles } from '../../__tests__/_scan-utils'

const parse = (source: string) => ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true)

/** The keys of `export const FAILED_RUN_CADENCES = { '<cron>': ..., ... }`: the crons whose jobs are counted. */
export function countedCadences(failuresSource: string): string[] {
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'FAILED_RUN_CADENCES' && node.initializer) {
      let init: ts.Expression = node.initializer
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression
      if (ts.isObjectLiteralExpression(init)) {
        for (const p of init.properties) if (ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.name)) out.push(p.name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(failuresSource))
  return out
}

/** The counted jobs of this Worker in CRON_JOBS: a counted cron, and no `worker` naming another. */
export function countedJobIds(registrySource: string, cadences: readonly string[]): string[] {
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'CRON_JOBS' && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
      for (const el of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(el)) continue
        const prop = (name: string) => {
          const p = el.properties.find((x): x is ts.PropertyAssignment => ts.isPropertyAssignment(x) && ts.isIdentifier(x.name) && x.name.text === name)
          return p && ts.isStringLiteralLike(p.initializer) ? p.initializer.text : undefined
        }
        const cron = prop('triggerCron')
        if (cron !== undefined && cadences.includes(cron) && prop('worker') === undefined && prop('id')) out.push(prop('id')!)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(registrySource))
  return out
}

/** Every `export const NAME_JOB = '<id>'` in the lib sources, by name. */
function jobConstants(): Map<string, string> {
  const out = new Map<string, string>()
  for (const file of listTsFiles(path.join(WORKER_SRC, 'lib'))) {
    if (file.includes('__tests__')) continue
    for (const m of readFileSync(file, 'utf8').matchAll(/export const ([A-Z_]+_JOB) = '([a-z0-9-]+)'/g)) out.set(m[1], m[2])
  }
  return out
}

export interface CompleteAfterCall {
  jobId: string | null
  /** The work's last step is a `.catch(...)`, which swallows the failure. */
  swallows: boolean
  /** The job's own failure line, passed as the third argument. */
  failedLine: boolean
}

/** Each completeAfter call in `source`, its job read from its own second argument. */
export function completeAfterCalls(source: string, constants: Map<string, string>): CompleteAfterCall[] {
  const out: CompleteAfterCall[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'completeAfter') {
      const [work, id, line] = node.arguments
      let jobId: string | null = null
      if (id && ts.isStringLiteralLike(id)) jobId = id.text
      else if (id && ts.isIdentifier(id)) jobId = constants.get(id.text) ?? null
      let last: ts.Expression | undefined = work
      while (last && ts.isParenthesizedExpression(last)) last = last.expression
      const swallows = !!last && ts.isCallExpression(last) && ts.isPropertyAccessExpression(last.expression) && last.expression.name.text === 'catch'
      out.push({ jobId, swallows, failedLine: line !== undefined })
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(source))
  return out
}

const INDEX = readFileSync(path.join(WORKER_SRC, 'index.ts'), 'utf8')
const REGISTRY = readFileSync(path.join(WORKER_SRC, 'lib/cron-heartbeat.ts'), 'utf8')
const FAILURES = readFileSync(path.join(WORKER_SRC, 'lib/minute-job-failures.ts'), 'utf8')

describe('a counted job stamped through completeAfter hands its failures to it (#2523, #2526)', () => {
  const cadences = countedCadences(FAILURES)
  const counted = new Set(countedJobIds(REGISTRY, cadences))
  const calls = completeAfterCalls(INDEX, jobConstants()).filter((c) => c.jobId !== null && counted.has(c.jobId))

  it('reads the counted cadences and the registry\'s jobs on them, and finds them stamped through completeAfter, so the checks below are not vacuous', () => {
    expect(cadences.sort()).toEqual(['*/15 * * * *', '*/5 * * * *', '* * * * *', '0 * * * *'].sort())
    expect(counted.has('ops-connection-logins')).toBe(true)
    expect(counted.has('ops-tick')).toBe(false)
    expect(counted.has('daily-1300')).toBe(false)
    expect(counted.has('execution-archive')).toBe(false)
    expect(calls.map((c) => c.jobId).sort()).toEqual([
      // Every minute (#2523).
      'buyer-sale-drain',
      'ops-connection-logins',
      'ops-connection-write-backs',
      'ops-tick-report',
      'salesforce-read-back',
      'unconfirmed-write-sweep',
      'writeback-drain',
      // Every five minutes, every fifteen, and hourly (#2526).
      'partner-reachability',
      'database-memory',
      'partner-page-monitor',
      'incident-drain',
      'writeback-backlog',
      'buyer-sales-checks',
      'tripoint-ping-outcome-rate',
      'click-path-checks',
      'buyer-select-parity',
      'live-share-refusals',
      'engine-script-drift',
    ].sort())
  })

  it('never ends a counted job\'s work in its own .catch, which would swallow the failure', () => {
    expect(calls.filter((c) => c.swallows).map((c) => c.jobId)).toEqual([])
  })

  it('passes each counted job\'s own failure line, which completeAfter logs', () => {
    expect(calls.filter((c) => !c.failedLine).map((c) => c.jobId)).toEqual([])
  })

  it('reads the cadences however the constant is typed', () => {
    expect(countedCadences("export const FAILED_RUN_CADENCES = { '* * * * *': { bound: 3 }, '0 * * * *': { bound: 2 } } as const satisfies X")).toEqual(['* * * * *', '0 * * * *'])
  })

  it('sees a swallowing .catch and a missing failure line, and reads the job from the second argument', () => {
    const constants = new Map([['X_JOB', 'x-job']])
    const [swallowed] = completeAfterCalls('completeAfter(writeHeartbeat(kv, X_JOB).then(() => run()).catch((e) => log(e)), X_JOB)', constants)
    expect(swallowed).toEqual({ jobId: 'x-job', swallows: true, failedLine: false })
    const [handed] = completeAfterCalls("completeAfter(writeHeartbeat(kv, X_JOB).catch(log).then(() => run()), X_JOB, '[x-job] failed:')", constants)
    expect(handed).toEqual({ jobId: 'x-job', swallows: false, failedLine: true })
    const [literal] = completeAfterCalls("completeAfter((run().catch(log)), 'y-job')", constants)
    expect(literal).toEqual({ jobId: 'y-job', swallows: true, failedLine: false })
  })
})
