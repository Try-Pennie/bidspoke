/**
 * The outage drill (#1305, plan on #1675): every money flow keeps answering its
 * caller, deciding and sending exactly what it would with the database up,
 * while the database is failing.
 *
 * It reuses the money gate's replay (replay-core.ts): the same fixtures, the
 * same live definitions, real Durable Objects and KV in workerd, code bundles
 * hosted as the engine builds them, and every outbound request answered by the
 * stub rules. It runs the head only, as its own CI job (Dan, 2026-10-07).
 *
 * For each live lead of each money flow:
 *  1. Warm the stored copies the way production does: the Worker's own prewarm
 *     cron plus one lead on a DIFFERENT prospect, so the lead under test meets
 *     no earlier sale or click of its own.
 *  2. Keep only the stored copies (keys named last-good), as an outage that
 *     outlived every short cache would find them.
 *  3. The twin: from that state, run the lead with the database up.
 *  4. For each outage shape (outage.ts), from that same state, run the lead with
 *     the database failing: the engine is handed the Worker's own lead client
 *     over a network that refuses, answers 503, answers an HTML 522, or hangs
 *     until the caller's own deadline aborts the request (#1851).
 *  5. Require the failing run to match its twin (outage.ts compareOutage), unless
 *     outage-exemptions.json names that flow's first difference with an open issue,
 *     and in the hang to answer within HUNG_ANSWER_ALLOWANCE_MS of it (lateAnswer).
 *
 * Decisions are read from the engine's step observer, because a failing run
 * never writes its step rows. Every post-response retry waits on an injected
 * clock that answers at once. The hung shape is the exception: it waits out each
 * lead's real deadlines, because how long the caller waits is what it measures
 * (#1876 tracks moving those onto the drill's clock).
 *
 * Not drilled, named in README: test and shadow runs (not lead bearing), the
 * custom endpoint route (the replay calls the engine directly; its stored record
 * is covered by its own tests), and the non-money Delegate Gmail workflow. A
 * database that hangs is drilled as the `hung` shape (#1851).
 */
import { env, reset } from 'cloudflare:test'
import { it, expect } from 'vitest'
import { moneyRuntime } from '@money-gate-engine/engine/index'
import { createLeadSupabaseClient } from '@money-gate-engine/lib/lead-read-budget'
import { prewarmKvCaches } from '@money-gate-engine/lib/cache-prewarm'
import { forgetIsolateMemory } from './isolate-memory'
import { generatePayload } from '../lib/generate'
import { fixtureId } from '../lib/run-kinds'
import type { WorkflowShape } from '../lib/shape'
import { runPlan, type Variant } from './replay-env'
import { definitions, dumpDurableObjects, hostBundles, runOnce, shapes, variantFiles, type DefinitionFile, type GateEnv, type RunResult } from './replay-core'
import {
  OUTAGE_DRILL_TIMEOUT_MS,
  OUTAGE_SHAPES,
  applyExemptions,
  compareOutage,
  decisionsFrom,
  firstStepOutputDifference,
  lateAnswer,
  isLastGoodKey,
  outageNetwork,
  type FixtureOutcome,
  type ObservedStep,
  type OutageExemption,
  type OutageRecord,
  type OutageShape,
} from '../lib/outage'
import exemptionsFile from '../outage-exemptions.json'

/** Not a money flow: it moves no lead and has no live traffic shape (README). */
const NOT_DRILLED = new Set(['Delegate Gmail Access for Offboarded Agents'])

/** One workflow to drill, for local iteration (vitest.outage-drill.config.mts); empty in CI. */
const ONLY = String((env as Record<string, unknown>).OUTAGE_DRILL_ONLY ?? '')

/** The KV namespaces the engine keeps stored copies in. */
const COPY_NAMESPACES = ['WORKFLOW_CACHE', 'IDEMPOTENCY'] as const

/**
 * A clock whose waits answer at once, so every post-response retry ladder runs
 * to its end instantly. A deadline watch never fires on its own, so it never
 * cuts a write short in either run.
 */
const instantClock = {
  now: () => Date.now(),
  sleep: async () => {},
  timer: (_ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  }),
}

/**
 * The clock for the hung shape (#1851). Its retry waits answer at once, and its
 * deadline watch fires after a quarter of a second rather than the 25 s budget:
 * long enough for post-response work that does not wait on the database, while
 * work stuck behind the hung database is cut, as the real budget would cut it.
 * Losing that logging is allowed (Dan, 2026-09-10).
 */
const HUNG_BUDGET_MS = 250
const hungClock = {
  now: () => Date.now(),
  sleep: async () => {},
  timer: (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(resolve, Math.min(ms, HUNG_BUDGET_MS))
    signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  }),
}

/**
 * The longest a single run may take, in real time. A run past it is not a result
 * to compare: it is a flow that never answers when the database hangs, or a wait
 * with no deadline, so it stops the whole drill and names the run (#1851).
 */
const RUN_DEADLINE_MS = 30_000

async function withinDeadline<T>(what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`outage drill: ${what} did not finish within ${RUN_DEADLINE_MS / 1000} s of real time, far past every deadline a lead waits on, so something in it waits with no deadline or one too long; the drill stops here`)), RUN_DEADLINE_MS)
  })
  try {
    return await Promise.race([work, late])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** The database address of the placeholder environment: never reached, the lead client brings its own network. */
const DB_ENV = { SUPABASE_URL: 'https://supabase-url.placeholder.invalid', SUPABASE_SECRET_KEY: 'money-gate-outage-drill' }

/** Each kept copy with its KV metadata, which since #1847 carries when it was last confirmed. */
type Kept = Record<string, Record<string, { value: string; metadata: unknown }>>

async function keepStoredCopies(e: GateEnv): Promise<Kept> {
  const kept: Kept = {}
  for (const name of COPY_NAMESPACES) {
    const kv = e[name] as KVNamespace
    const entries: Record<string, { value: string; metadata: unknown }> = {}
    for (const key of await allKeys(kv)) {
      if (!isLastGoodKey(key)) continue
      const { value, metadata } = await kv.getWithMetadata(key)
      if (value !== null) entries[key] = { value, metadata }
    }
    kept[name] = entries
  }
  return kept
}

async function restore(e: GateEnv, kept: Kept): Promise<void> {
  for (const [name, entries] of Object.entries(kept)) {
    const kv = e[name] as KVNamespace
    for (const [k, { value, metadata }] of Object.entries(entries)) await kv.put(k, value, metadata == null ? undefined : { metadata })
  }
}

/** Every key in a namespace, following the listing's cursor past its first page. */
async function allKeys(kv: KVNamespace): Promise<string[]> {
  const names: string[] = []
  let cursor: string | undefined
  do {
    const page: KVNamespaceListResult<unknown> = await kv.list({ cursor })
    for (const k of page.keys) names.push(k.name)
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return names
}

/** Drops every key a prior run left that is not a stored copy, so the recorded run meets only the copies. */
async function dropFastKeys(e: GateEnv): Promise<void> {
  for (const name of COPY_NAMESPACES) {
    const kv = e[name] as KVNamespace
    for (const key of await allKeys(kv)) if (!isLastGoodKey(key)) await kv.delete(key)
  }
}

function recordOf(run: RunResult, steps: ObservedStep[], doState: Record<string, unknown>): OutageRecord {
  return {
    response: run.response,
    // Which node a request is attributed to rides on log lines; what was sent is compared.
    outbound: run.outbound.map(({ via, method, host, path, headers, body }) => ({ via, method, host, path, headers: headers as Record<string, string> | undefined, body })),
    code_dispatch: run.codeDispatch.map(({ binding, name, path, namespaces }) => ({ binding, name, path, namespaces })),
    decisions: decisionsFrom(steps),
    do_state: doState,
    error: run.error,
  }
}

const observer = (into: ObservedStep[]) => (entry: ObservedStep) => {
  into.push({ step_order: entry.step_order, step_namespace: entry.step_namespace, step_node_id: entry.step_node_id, step_type: entry.step_type, output: structuredClone(entry.output) })
}

it('keeps every money flow answering, as it would with the database up, while the database fails', async () => {
  const e = env as unknown as GateEnv
  try {
    await drill(e)
  } finally {
    await e.GATE_IO.fetch('https://gate/dispose', { method: 'POST' })
  }
}, OUTAGE_DRILL_TIMEOUT_MS)

/** Where the drill's time goes, by phase, so a slow run names its cause (L466). */
const phaseMs: Record<string, number> = {}
async function timed<T>(phase: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now()
  try {
    return await work()
  } finally {
    phaseMs[phase] = (phaseMs[phase] ?? 0) + (performance.now() - start)
  }
}

async function drill(e: GateEnv): Promise<void> {
  await timed('host bundles', () => hostBundles(e))
  const outcomes: FixtureOutcome[] = []
  const controlFailures: string[] = []
  const variantsByWorkflow = new Map(variantFiles.map((v) => [v.workflow_id, v]))
  let fixtures = 0

  for (const def of [...definitions].sort((a, b) => (a.name < b.name ? -1 : 1)) as DefinitionFile[]) {
    if (NOT_DRILLED.has(def.name)) continue
    if (ONLY && def.name !== ONLY) continue
    const shape = shapes.workflows.find((w) => w.workflow_id === def.id) as WorkflowShape | undefined
    if (!shape) throw new Error(`no shape for ${def.name}; rerun scripts/export-money-fixture-shapes.ts`)
    for (const { variant } of runPlan(variantsByWorkflow.get(def.id)).filter((p) => p.kind === 'live')) {
      const id = fixtureId(def.name, variant.name, 'live')
      const stubs = variant.stubs ?? {}

      // 1 and 2. Warm on a different prospect, with the prewarm cron, then keep only the copies.
      await timed('reset', async () => { await reset(); forgetIsolateMemory() })
      const warmPayload = generatePayload(shape, { seed: `${id}#warm`, set: variant.set, unset: variant.unset })
      const warm = await timed('warm run', () => runOnce(e, def, { id: `${id}#warm`, seed: `${id}#warm`, kind: 'live' }, warmPayload, variant, stubs, shape, {
        // Real timers on every drill run (#1872): the hung shape ends only when the caller's own deadline fires.
        engineTimers: 'real',
        before: (runEnv, db) => timed('prewarm', () => prewarmKvCaches(db.client as never, runEnv as never)),
      }))
      const kept = await timed('keep copies', () => keepStoredCopies(e))
      // A positive control on the warming: every run loads its definition, so a
      // warm run that left no definition copy warmed nothing, and every difference
      // after it would be blamed on the engine. Some warm runs end in an error by
      // design, as their twin does, so the copy is what is required.
      if (!kept.WORKFLOW_CACHE[`workflow-def-lastgood:${def.id}`]) {
        controlFailures.push(`${def.name}/${variant.name}: the warm run left no definition copy, so nothing was warmed${warm.error ? ` (it ended: ${warm.error})` : ''}`)
        continue
      }

      const payload = generatePayload(shape, { seed: id, set: variant.set, unset: variant.unset })
      const fromKept = async () => {
        await timed('reset', async () => { await reset(); forgetIsolateMemory() })
        await timed('restore copies', () => restore(e, kept))
        await timed('prior runs', () => priorRuns(e, def, id, payload, variant, shape))
        await timed('drop fast keys', () => dropFastKeys(e))
      }

      // 3. The twin, database up.
      await fromKept()
      const upSteps: ObservedStep[] = []
      const up = await timed('up run', () => runOnce(e, def, { id, seed: id, kind: 'live' }, payload, variant, stubs, shape, {
        engineTimers: 'real',
        runtime: (db) => ({ ...moneyRuntime(db.client as never), observeStep: observer(upSteps), clock: instantClock }),
      }))
      const upRecord = recordOf(up, upSteps, await dumpDurableObjects(e))

      // 4. Each outage shape, from the same state.
      for (const outage of OUTAGE_SHAPES) {
        await fromKept()
        const net = outageNetwork(outage)
        const downSteps: ObservedStep[] = []
        const down = await timed('down run', () => withinDeadline(`${def.name}/${variant.name} [${outage}]`, runOnce(e, def, { id, seed: id, kind: 'live' }, payload, variant, stubs, shape, {
          engineTimers: 'real',
          runtime: () => {
            const client = createLeadSupabaseClient(DB_ENV as never, { fetch: net.fetch })
            return { lane: 'money', config: client, run: client, observeStep: observer(downSteps), clock: outage === 'hung' ? hungClock : instantClock }
          },
          // The hung shape's post-response work can wait on the database for ever;
          // it is cut a little after its own budget clock gives up, as Cloudflare
          // cuts it 30 s after the response. The deadline then measures the answer.
          ...(outage === 'hung' ? { postResponseLimitMs: HUNG_BUDGET_MS * 4 } : {}),
        })))
        fixtures++
        // A positive control: a run that never asked the database proves nothing about an outage.
        if (net.requests() === 0) controlFailures.push(`${def.name}/${variant.name} [${outage}]: the run never asked the database, so it was not drilled`)
        const diffs = compareOutage(upRecord, recordOf(down, downSteps, await dumpDurableObjects(e)))
        // A hung database must not slow the answer past the lead read budget.
        const late = outage === 'hung' && up.answeredMs !== null && down.answeredMs !== null ? lateAnswer(up.answeredMs, down.answeredMs) : null
        if (late) diffs.push(late)
        outcomes.push({ workflow: def.name, variant: variant.name, shape: outage as OutageShape, diffs, ...(diffs.length ? { first_step_difference: firstStepOutputDifference(upSteps, downSteps) } : {}) })
      }
    }
  }

  expect(fixtures, ONLY ? `no workflow named ${JSON.stringify(ONLY)} was drilled` : 'the drill ran no fixture at all, so it measured nothing').toBeGreaterThan(0)
  const today = new Date().toISOString().slice(0, 10)
  const exemptions = (exemptionsFile as { exemptions: OutageExemption[] }).exemptions.filter((e) => !ONLY || e.workflow === ONLY)
  const verdict = applyExemptions(outcomes, exemptions, today)
  const report = [
    `outage drill${ONLY ? ` NARROWED to ${ONLY}` : ''}: ${fixtures} fixtures, ${outcomes.filter((o) => o.diffs.length === 0).length} matched their twin, ${verdict.excused.length} excused by an open exemption`,
    `time by phase (s): ${Object.entries(phaseMs).sort(([, a], [, b]) => b - a).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}`).join(', ')}`,
    ...verdict.excused.map((f) => `  excused ${f.workflow}/${f.variant} [${f.shape}]: ${f.diffs[0].field}: ${f.diffs[0].detail.slice(0, 200)}`),
  ].join('\n')
  await e.GATE_IO.fetch('https://gate/transcript', { method: 'POST', body: JSON.stringify({ report, outcomes }, null, 1) })
  expect([...controlFailures, ...verdict.failures], report).toEqual([])
}

/** The variant's prior runs (an earlier click on the same prospect), database up, as the gate replays them. */
async function priorRuns(e: GateEnv, def: DefinitionFile, id: string, payload: unknown, variant: Variant, shape: WorkflowShape): Promise<void> {
  for (let i = 0; i < (variant.prior_runs ?? 0); i++) {
    await runOnce(e, def, { id: `${id}#prior${i}`, seed: `${id}#prior${i}`, kind: 'live' }, payload, variant, variant.prior_stubs ?? variant.stubs ?? {}, shape, { engineTimers: 'real' })
  }
}
