/**
 * Guard: every job in the worker's heartbeat registry is stamped by the
 * scheduled handler (#1413, L694, L660).
 *
 * A job registered in CRON_JOBS and never stamped reads as never having run,
 * for ever, with a remedy aimed at cron triggers that are fine: that is what
 * #1332 was, and the unstamped verdict only softens it after the fact. This
 * reads the registry file and the handler's source, so a job added to one
 * without the other fails here rather than in Slack.
 *
 * The handler names a job either by its literal or by a constant exported from
 * a lib module (`export const ARCHIVE_EXPIRY_JOB = 'execution-archive-expiry'`),
 * so constants are resolved from the lib sources rather than guessed from the id.
 *
 * Seen to fail with the drain's writeHeartbeat line removed from index.ts, and
 * (#2522) with the completion id of ops-connection-logins removed from, or
 * swapped for another job's in, its completeAfter call. Each stamp's id is read
 * from the call's own second argument by parsing the source, so a job's id in
 * the start stamp inside completeAfter's first argument no longer counts as its
 * completion.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { WORKER_SRC, listTsFiles } from '../../__tests__/_scan-utils'
import { STAMPED_IN, jobWorkers } from './_cron-registry'

const INDEX_SOURCE = readFileSync(path.join(WORKER_SRC, 'index.ts'), 'utf8')
const REGISTRY_SOURCE = readFileSync(path.join(WORKER_SRC, 'lib/cron-heartbeat.ts'), 'utf8')

/** The job ids the registry declares, read from its source. */
export function registeredJobIds(registrySource: string): string[] {
  const start = registrySource.indexOf('export const CRON_JOBS')
  const end = registrySource.indexOf('\n]', start)
  const block = registrySource.slice(start, end)
  return [...block.matchAll(/^\s+id: '([a-z0-9-]+)',/gm)].map((m) => m[1])
}

/** Every `export const NAME_JOB = '<id>'` in the lib sources, keyed by the id. */
function jobConstants(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const file of listTsFiles(path.join(WORKER_SRC, 'lib'))) {
    if (file.includes('__tests__')) continue
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/export const ([A-Z_]+_JOB) = '([a-z0-9-]+)'/g)) {
      out.set(m[2], [...(out.get(m[2]) ?? []), m[1]])
    }
  }
  return out
}

/** The calls the stamps are made by, each of which names its job as its own SECOND argument. */
const STAMP_CALLS = ['writeHeartbeat', 'completeAfter', 'writeHeartbeatCompleted'] as const
type StampCall = (typeof STAMP_CALLS)[number]

/**
 * The job each stamp call names, read from the call's own second argument by
 * parsing the source (#2522), never from the text around the call: completeAfter
 * in the shared minute job style carries the job's START stamp, and so its id,
 * inside its first argument, which a text match took for the completion. A
 * literal is kept quoted and a constant by its name, the forms `names` uses.
 */
const parsed = new Map<string, Record<StampCall, Set<string>>>()
function stampIds(source: string): Record<StampCall, Set<string>> {
  const known = parsed.get(source)
  if (known) return known
  const out = { writeHeartbeat: new Set<string>(), completeAfter: new Set<string>(), writeHeartbeatCompleted: new Set<string>() }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text
      const id = node.arguments[1]
      if ((STAMP_CALLS as readonly string[]).includes(callee) && id) {
        if (ts.isStringLiteralLike(id)) out[callee as StampCall].add(`'${id.text}'`)
        else if (ts.isIdentifier(id)) out[callee as StampCall].add(id.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile('stamps.ts', source, ts.ScriptTarget.Latest, true))
  parsed.set(source, out)
  return out
}

/** The two calls the handler must make for a job id: the started stamp and the settled stamp. */
export function stampsFor(source: string, jobId: string, constants: Map<string, string[]>): { started: boolean; completed: boolean } {
  const names = [`'${jobId}'`, ...(constants.get(jobId) ?? [])]
  const ids = stampIds(source)
  // writeHeartbeat may carry a clock after the id: lib/ops-gateway.ts passes
  // this Worker's own (#1949). writeHeartbeatCompleted is read inside its own
  // call only, as every stamp now is: the ops jobs' stamps sit side by side in
  // one switch (lib/ops-gateway.ts, #2340), so one job's stamp must never stand
  // in for another's that was removed.
  const started = names.some((n) => ids.writeHeartbeat.has(n))
  const completed = names.some((n) => ids.completeAfter.has(n) || ids.writeHeartbeatCompleted.has(n))
  return { started, completed }
}

describe('every registered cron job is stamped by the scheduled handler', () => {
  const ids = registeredJobIds(REGISTRY_SOURCE)
  const constants = jobConstants()

  it('the registry was read, the handler was read, and the constants were found', () => {
    expect(ids.length).toBeGreaterThan(5)
    expect(ids).toContain('daily-1300')
    expect(ids).toContain('buyer-sale-drain')
    expect(INDEX_SOURCE).toContain('scheduled(event: ScheduledEvent')
    expect(constants.get('execution-archive-expiry')).toEqual(['ARCHIVE_EXPIRY_JOB'])
  })

  const workers = jobWorkers(REGISTRY_SOURCE)
  for (const id of ids) {
    const worker = workers.get(id)
    const file = worker ? STAMPED_IN[worker] : 'index.ts'
    it(`${id} has a started stamp and a settled stamp${worker ? ` in ${file}, where ${worker} stamps it` : ' reachable from scheduled()'}`, () => {
      expect(file, `${id} names worker ${worker}, which no stamping source is listed for`).toBeDefined()
      const s = stampsFor(readFileSync(path.join(WORKER_SRC, file!), 'utf8'), id, constants)
      expect(s.started, `${id}: no writeHeartbeat(..., '${id}') in apps/worker/src/${file}`).toBe(true)
      expect(s.completed, `${id}: no completeAfter or writeHeartbeatCompleted for '${id}' in apps/worker/src/${file}`).toBe(true)
    })
  }

  it('reads a job of another Worker out of the registry, so the split above is not vacuous (#1949)', () => {
    expect(workers.get('ops-tick')).toBe('bidspoke-worker-ops')
    expect(workers.has('daily-1300')).toBe(false)
  })

  it('reports a job the handler never stamps, so a green run means the scan can see an omission', () => {
    expect(stampsFor(INDEX_SOURCE, 'no-such-job', constants)).toEqual({ started: false, completed: false })
    expect(stampsFor("writeHeartbeat(env.IDEMPOTENCY, 'x-job')\ncompleteAfter(p, 'x-job')", 'x-job', new Map())).toEqual({ started: true, completed: true })
    expect(stampsFor("writeHeartbeat(env.IDEMPOTENCY, X_JOB)\nwriteHeartbeatCompleted(env.IDEMPOTENCY, X_JOB)", 'x-job', new Map([['x-job', ['X_JOB']]]))).toEqual({ started: true, completed: true })
    // Two jobs stamped side by side: removing one's completed stamp is seen, though the other's sits just above it (#2340).
    const sideBySide = "switch (job) {\ncase A_JOB:\n  await writeHeartbeatCompleted(kv, A_JOB, nowMs)\n  break\ncase B_JOB:\n  await Promise.resolve()\n  break\n}"
    expect(stampsFor(sideBySide, 'b-job', new Map([['b-job', ['B_JOB']]])).completed).toBe(false)
    expect(stampsFor(sideBySide, 'a-job', new Map([['a-job', ['A_JOB']]])).completed).toBe(true)
  })

  // The shared minute job style (#2522): the start stamp sits inside completeAfter's
  // FIRST argument, so a job's id appears in the call whether or not the completion
  // names it. Only the second argument is the completion's id.
  const minuteStyle = (completionId: string) =>
    `minuteJob(X_JOB, completeAfter(\n  writeHeartbeat(env.IDEMPOTENCY, X_JOB)\n    .then(() => run(X_JOB))\n    .catch((e) => console.error(e)),\n  ${completionId},\n))`
  const xJob = new Map([['x-job', ['X_JOB']], ['y-job', ['Y_JOB']]])

  it('reads completeAfter\'s id from its own second argument, never from the start stamp inside its first (#2522)', () => {
    expect(stampsFor(minuteStyle('X_JOB'), 'x-job', xJob)).toEqual({ started: true, completed: true })
    // The completion swapped to another job: this one has no completion, the other one has.
    expect(stampsFor(minuteStyle('Y_JOB'), 'x-job', xJob)).toEqual({ started: true, completed: false })
    expect(stampsFor(minuteStyle('Y_JOB'), 'y-job', xJob).completed).toBe(true)
    // The completion's id written as a literal of another job.
    expect(stampsFor(minuteStyle("'other-job'"), 'x-job', xJob).completed).toBe(false)
    // The completion removed: completeAfter called with the work alone.
    const removed = 'completeAfter(writeHeartbeat(env.IDEMPOTENCY, X_JOB).then(() => run(X_JOB)))'
    expect(stampsFor(removed, 'x-job', xJob)).toEqual({ started: true, completed: false })
    // The id passed as a THIRD argument is not the completion's id either.
    expect(stampsFor('completeAfter(writeHeartbeat(kv, X_JOB), Y_JOB, X_JOB)', 'x-job', xJob).completed).toBe(false)
  })

  it('reads writeHeartbeat\'s id from its own second argument too (#2522)', () => {
    // Another job's start stamp whose third argument names this job is not this job's start.
    expect(stampsFor('writeHeartbeat(kv, Y_JOB, X_JOB)', 'x-job', xJob).started).toBe(false)
    expect(stampsFor('writeHeartbeat(kv, X_JOB, nowMs)', 'x-job', xJob).started).toBe(true)
  })
})
