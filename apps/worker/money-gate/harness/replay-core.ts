/**
 * The replay machinery the money gate (replay.workers.test.ts, #1704) and the
 * outage drill (outage.workers.test.ts, #1305) share: the fixtures, bundle
 * hosting, alarm holding, one run of a workflow through the engine under test,
 * and the capture of Durable Object and KV state. One copy, so the two cannot
 * drift apart.
 */
import { env, listDurableObjectIds, runInDurableObject, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { expect, vi } from 'vitest'
import { executeWorkflow, moneyRuntime } from '@money-gate-engine/engine/index'
import { buildBundledWorkerScript, codeBundleName, deployTestCodeBundle } from '@money-gate-engine/lib/code-node-deployer'
import * as deployer from '@money-gate-engine/lib/code-node-deployer'
import { uuidv7 } from '@bidspoke/uuidv7'
import { createSupabaseDouble, type RecordedWrite, type Row } from '../lib/supabase-double'
import { parseBody, redactBody, redactHeaders, redactPathAndQuery } from '../lib/redact'
import { noRuleAnswer, readBodyText, stubAnswer, toResponse, type Arms } from '../lib/stub-rules'
import type { CodeDispatchRecord, FixtureRecord, OutboundRecord, RouteRecord, WorkflowArms } from '../lib/compare'
import type { ShapesFile, WorkflowShape } from '../lib/shape'
import type { ConfigSnapshot } from '../lib/snapshot'
import { runOptions, type RunKind } from '../lib/run-kinds'
import { scriptFromUpload } from '../lib/test-bundle-upload'
import { FIXED_TIME_MS, buildEnv, type VariantFile, type Variant } from './replay-env'
import type { HostedBundle } from '../lib/hosted-bundle'
import { liftStepDeadlines } from '../lib/step-deadlines'
import { liftEngineTimers, type FiredTimer, type LiftedTimers, type TimerHost } from '../lib/engine-timers'
import { waitAtMost } from '../lib/wait-at-most'
import { abDefinitions, abModeOf } from '../swap/ab'
import shapesFile from '../fixtures/shapes.json'
import snapshotFile from '../fixtures/config-snapshot.json'

/** The timer the harness itself waits on, taken before any run lifts the engine's (#1872). */
const harnessSetTimeout = globalThis.setTimeout

export interface DefinitionFile { id: string; name: string; definition: { nodes: Array<{ id: string; namespace: string; type: string; config?: Record<string, unknown> }>; edges: Array<{ source: string; target: string; source_handle?: string }> } }

/**
 * The definition A/B mode of a validation swap (#2591, money-gate/swap/ab.ts), or
 * null for the ordinary gate. Set only by .github/scripts/money-gate-swap.sh,
 * through vitest.money-gate.config.mts.
 */
const textBinding = (name: string): string | undefined => {
  const v = (env as Record<string, unknown>)[name]
  return typeof v === 'string' && v !== '' ? v : undefined
}
export const AB_MODE = abModeOf({
  candidate: textBinding('MONEY_GATE_CANDIDATE'),
  side: textBinding('MONEY_GATE_CANDIDATE_SIDE'),
  seed: textBinding('MONEY_GATE_CANDIDATE_SEED'),
})

// Every timer a definition sets is lifted far above any real step, on both sides
// alike, so a slow runner can never time a step out on one side only (#1796). In
// A/B mode, only the candidate's workflow, with the candidate in place on its side.
export const definitions = abDefinitions(
  Object.values(import.meta.glob<DefinitionFile>('../fixtures/definitions/*.json', { eager: true, import: 'default' })).map(liftStepDeadlines),
  import.meta.glob<unknown>('../swap/candidates/*.json', { eager: true, import: 'default' }),
  AB_MODE,
)
export const variantFiles = Object.values(import.meta.glob<VariantFile>('../fixtures/variants/*.json', { eager: true, import: 'default' }))
export const shapes = shapesFile as unknown as ShapesFile
export const snapshot = snapshotFile as unknown as ConfigSnapshot

/** The engine under test's dispatch namespaces, from its wrangler.toml (vitest.money-gate.config.mts). */
const dispatchNamespacesText = (env as Record<string, unknown>).MONEY_GATE_DISPATCH_NAMESPACES
// Not a string means no namespace reached the replay, which hostBundles refuses by name.
export const DISPATCH_NAMESPACES = JSON.parse(typeof dispatchNamespacesText === 'string' ? dispatchNamespacesText : '[]') as Array<{ binding: string; namespace: string; outbound: string | null }>
const DISPATCH_BINDINGS = new Set(DISPATCH_NAMESPACES.map((d) => d.binding))

/**
 * Every node that routes by a handle, and its handles. `output` is the pass through
 * edge to a branch's join (or a node's fallback), never a route the node names, so it
 * is not an arm where a node has named handles. An arm no input can reach (Main
 * Flow's debt_screening else, behind a screen that already required what it lacks)
 * is listed as not reached like any other: the report says so, it does not hide it.
 */
export function armsOf(def: DefinitionFile): WorkflowArms {
  const arms: WorkflowArms['arms'] = []
  for (const n of def.definition.nodes) {
    // A parallel node runs every child; its handles are a fan out, not a choice.
    if (n.type === 'parallel') continue
    const handles = [...new Set(def.definition.edges.filter((e) => e.source === n.id).map((e) => e.source_handle ?? 'output'))]
    const named = handles.filter((h) => h !== 'output')
    if (named.length === 0) continue
    arms.push({ node: n.id, namespace: n.namespace, handles: named.sort() })
  }
  return {
    workflow_id: def.id,
    workflow_name: def.name,
    nodes: def.definition.nodes.map((n) => n.namespace).sort(),
    arms,
  }
}

// ── Determinism (L504) ──────────────────────────────────────────────────────

function seededBytes(seedText: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < seedText.length; i++) { h ^= seedText.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  let state = h
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pinRandomness(seed: string) {
  const next = seededBytes(seed)
  vi.spyOn(Math, 'random').mockImplementation(next)
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(((arr: ArrayBufferView) => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(next() * 256)
    return arr
  }) as typeof crypto.getRandomValues)
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
    const b = new Uint8Array(16)
    for (let i = 0; i < 16; i++) b[i] = Math.floor(next() * 256)
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  })
}

// ── Durable Object and KV state ─────────────────────────────────────────────

/**
 * Durable Object alarms, held rather than scheduled (#1789).
 *
 * An object arms its alarm from the pinned clock, so the time it asks for is long
 * past in real time. workerd moves such an alarm to the real now and fires it at
 * once, and an object that re-arms on every firing (the buyer ledger, while a
 * reservation is pending) fires for ever. Each firing that met the real clock moved
 * the run's state on (reserved to unresolved), and the captured alarm time was
 * whatever real instant the loop had reached, so base and head could differ with
 * nothing changed.
 *
 * So the replay stands in for the scheduler, as it does for Supabase and every
 * outbound call: an alarm an object sets is recorded against its storage and never
 * fires, getAlarm answers with the time the object asked for, and the capture reads
 * exactly that. An alarm is a later event, never part of the run being replayed.
 */
const heldAlarms = new WeakMap<object, number | null>()
/** The platform's own getAlarm, kept so a capture can confirm nothing was scheduled with it. */
let platformGetAlarm: ((this: DurableObjectStorage) => Promise<number | null>) | null = null
export async function holdAlarms(e: Record<string, unknown>): Promise<void> {
  for (const name of Object.keys(e).sort()) {
    if (name === 'GATE_IO' || DISPATCH_BINDINGS.has(name)) continue
    const ns = e[name] as DurableObjectNamespace
    if (!ns || typeof (ns as { idFromName?: unknown }).idFromName !== 'function') continue
    // Any object's storage reaches the prototype every object's storage shares; the
    // probe object it creates is gone with the first fixture's reset.
    await runInDurableObject(ns.get(ns.idFromName('money-gate-alarm-probe')), async (_instance: unknown, state: DurableObjectState) => {
      const proto = Object.getPrototypeOf(state.storage) as Record<string, unknown>
      platformGetAlarm ??= proto.getAlarm as typeof platformGetAlarm
      // Each returns a promise, as the platform's do, without awaiting anything.
      proto.setAlarm = function (this: object, at: number | Date): Promise<void> {
        heldAlarms.set(this, typeof at === 'number' ? at : at.getTime())
        return Promise.resolve()
      }
      proto.getAlarm = function (this: object): Promise<number | null> {
        return Promise.resolve(heldAlarms.get(this) ?? null)
      }
      proto.deleteAlarm = function (this: object): Promise<void> {
        heldAlarms.set(this, null)
        return Promise.resolve()
      }
      // The stand in must be what an object reaches: an alarm set through storage is
      // answered back as asked, and the platform holds none.
      await state.storage.setAlarm(FIXED_TIME_MS)
      expect(await state.storage.getAlarm(), 'money gate: an alarm set through storage was not held by the replay').toBe(FIXED_TIME_MS)
      expect(await platformGetAlarm!.call(state.storage), 'money gate: an alarm set through storage reached the platform scheduler').toBeNull()
      await state.storage.deleteAlarm()
    })
    return
  }
  throw new Error('money gate: no Durable Object namespace reached the replay, so alarms cannot be held')
}

export async function dumpDurableObjects(e: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const name of Object.keys(e).sort()) {
    // A service binding answers any property name, so it is excluded by name.
    if (name === 'GATE_IO' || DISPATCH_BINDINGS.has(name)) continue
    const ns = e[name] as DurableObjectNamespace
    if (!ns || typeof (ns as { idFromName?: unknown }).idFromName !== 'function') continue
    let ids: DurableObjectId[]
    try {
      ids = await listDurableObjectIds(ns)
    } catch {
      continue
    }
    const objects: Record<string, unknown> = {}
    for (const id of ids) {
      objects[id.toString()] = await runInDurableObject(ns.get(id), async (_instance: unknown, state: DurableObjectState) => {
        const kv = Object.fromEntries(await state.storage.list())
        const tables: Record<string, unknown> = {}
        try {
          const names = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").toArray()
          for (const t of names) {
            // sqlite_master.name is always text.
            const table = t.name as string
            const rows = state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray()
            tables[table] = rows.map((r) => JSON.stringify(r)).sort()
          }
        } catch {
          // A key value object has no SQL storage; its state is the list above.
        }
        // Nothing may be scheduled with the platform, or it fires during the replay.
        if (platformGetAlarm && (await platformGetAlarm.call(state.storage)) !== null) {
          throw new Error(`money gate: ${name} ${id.toString()} holds an alarm with the platform scheduler, which fires during the replay; set alarms through storage so the replay holds them`)
        }
        return { kv, tables, alarm: await state.storage.getAlarm() }
      })
    }
    out[name] = objects
  }
  return out
}

export async function dumpKv(e: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const name of ['WORKFLOW_CACHE', 'IDEMPOTENCY', 'SUBMISSIONS']) {
    const kv = e[name] as KVNamespace | undefined
    if (!kv) continue
    const entries: Record<string, unknown> = {}
    let cursor: string | undefined
    do {
      const page: KVNamespaceListResult<unknown> = await kv.list({ cursor })
      for (const k of page.keys) entries[k.name] = await kv.get(k.name)
      cursor = page.list_complete ? undefined : page.cursor
    } while (cursor)
    out[name] = entries
  }
  return out
}


// ── The run ─────────────────────────────────────────────────────────────────

export type GateEnv = Record<string, unknown> & { GATE_IO: Fetcher }

type DeployFn = (workflowId: string, definition: never, accountId: string, apiToken: string, cache: KVNamespace) => Promise<{ bundleName: string | null; error?: string }>

/**
 * A hashed bundle the engine under test deploys itself, as its route would: the
 * Test Runner's test bundle (routes/api/workflows.ts, POST /:id/test) and the
 * shadow route's compare bundle (routes/shadow.ts, #1708 part B). The gate calls
 * the engine's own deploy function with the route's arguments; its upload to
 * Cloudflare is answered here and never sent, and the script it uploaded (the
 * part its metadata names as main_module) is hosted under the name it chose, in
 * the namespace its upload URL names. Null when it deployed nothing, which the
 * route also runs with. An upload the gate cannot read a script from stops the
 * replay, naming the workflow, the bundle and what was missing.
 */
async function deployCaptured(e: GateEnv, d: DefinitionFile, label: string, deploy: DeployFn): Promise<HostedBundle | null> {
  const env = buildEnv(e, {}, d)
  const uploads: Array<{ url: string; read: Awaited<ReturnType<typeof scriptFromUpload>> }> = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    if (new URL(req.url).host !== 'api.cloudflare.com' || req.method !== 'PUT') {
      return new Response(`money gate: network is off; the ${label} deploy reached ${req.method} ${req.url}`, { status: 598 })
    }
    uploads.push({ url: req.url, read: await scriptFromUpload(await req.formData()) })
    return Response.json({ success: true, errors: [], messages: [], result: {} })
  })
  const quiet = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const dep = await deploy(d.id, d.definition as never, env.CLOUDFLARE_ACCOUNT_ID as string, env.CLOUDFLARE_API_TOKEN as string, e.WORKFLOW_CACHE as KVNamespace)
    if (dep.error) throw new Error(`money gate: the ${label} deploy refused ${d.name}: ${dep.error}`)
    if (!dep.bundleName) return null
    const upload = uploads.find((u) => u.url.endsWith(`/scripts/${dep.bundleName}`))
    if (!upload) throw new Error(`money gate: the ${label} deploy named ${dep.bundleName} for ${d.name} but uploaded no script under it`)
    if ('problem' in upload.read) throw new Error(`money gate: the ${label} deploy's upload of ${dep.bundleName} for ${d.name} cannot be hosted: ${upload.read.problem}`)
    const namespace = /\/dispatch\/namespaces\/([^/]+)\/scripts\//.exec(new URL(upload.url).pathname)?.[1]
    if (!namespace) throw new Error(`money gate: the ${label} deploy of ${dep.bundleName} for ${d.name} uploaded to ${upload.url}, which names no dispatch namespace`)
    return { name: dep.bundleName, script: upload.read.script, namespace }
  } finally {
    globalThis.fetch = realFetch
    quiet.mockRestore()
  }
}

/**
 * The engine under test's compare bundle deploy, or undefined for an engine from
 * before #1708 part B, whose shadow runs refuse code by name instead.
 */
const deployCompare = (deployer as Partial<typeof deployer>).deployCompareCodeBundle as DeployFn | undefined

/** The bundles a run dispatches to, by workflow id, as hostBundles hosted them. */
export interface HostedBundles { testBundles: Map<string, string>; compareBundles: Map<string, string> }

/**
 * Hosts every workflow's code bundle, built by the engine under test's own
 * builder, plus the test bundle its Test Runner would deploy and the compare
 * bundle its shadow route would deploy, each in the namespace it is dispatched
 * from, then holds Durable Object alarms. Run once, before the first fixture.
 */
export async function hostBundles(e: GateEnv): Promise<HostedBundles> {
  if (DISPATCH_NAMESPACES.length === 0) throw new Error('money gate: no dispatch namespace reached the replay; vitest.money-gate.config.mts reads them from wrangler.toml')
  // Host each workflow's code bundle, built by the engine under test's own builder,
  // the test bundle its Test Runner would deploy, and the compare bundle its shadow
  // route would deploy, each in the namespace it is dispatched from.
  const moneyNamespace = DISPATCH_NAMESPACES.find((d) => d.binding === 'DYNAMIC_WORKER_LOADER')?.namespace
  if (!moneyNamespace) throw new Error('money gate: the engine under test binds no DYNAMIC_WORKER_LOADER, so its code has nowhere to run')
  const bundles: HostedBundle[] = []
  const testBundles = new Map<string, string>()
  const compareBundles = new Map<string, string>()
  for (const d of definitions) {
    const scripts = d.definition.nodes
      .filter((n) => n.type === 'code' && typeof n.config?.script === 'string' && (n.config.script).trim().length > 0)
      .map((n) => ({ namespace: n.namespace, script: n.config!.script as string }))
    if (scripts.length === 0) continue
    bundles.push({ name: codeBundleName(d.id), script: buildBundledWorkerScript(scripts), namespace: moneyNamespace })
    const test = await deployCaptured(e, d, 'test bundle', deployTestCodeBundle)
    if (test) {
      bundles.push(test)
      testBundles.set(d.id, test.name)
    }
    const compare = deployCompare ? await deployCaptured(e, d, 'compare bundle', deployCompare) : null
    if (compare) {
      bundles.push(compare)
      compareBundles.set(d.id, compare.name)
    }
  }
  const hosted = await e.GATE_IO.fetch('https://gate/bundles', { method: 'POST', body: JSON.stringify({ bundles }) })
  expect(hosted.status, await hosted.clone().text()).toBe(200)
  await holdAlarms(e)
  return { testBundles, compareBundles }
}

/** Which fixture a recorded run is: its id, workflow, variant and kind. */
export interface FixtureIdentity { id: string; variant: string; kind: RunKind }

/**
 * The gate's record of one run: decisions read back from the engine's own
 * execution_steps and workflow_executions writes, with everything it sent.
 */
export async function recordFixture(e: GateEnv, def: DefinitionFile, who: FixtureIdentity, run: RunResult): Promise<FixtureRecord> {
  const writes: RecordedWrite[] = run.db.writes()
  const stepRows = writes
    .filter((w) => w.table === 'execution_steps' && (w.op === 'insert' || w.op === 'upsert'))
    .flatMap((w) => w.values as Array<Record<string, unknown>>)
    // Parallel children share a step order; the namespace breaks the tie the same way every run.
    .sort((a, b) => Number(a.step_order) - Number(b.step_order) || String(a.step_namespace).localeCompare(String(b.step_namespace)))
  const routes: RouteRecord[] = stepRows
    .filter((r) => r.output && typeof r.output === 'object' && typeof (r.output as Record<string, unknown>)._route === 'string')
    .map((r) => ({ node: String(r.step_node_id ?? r.step_namespace), namespace: String(r.step_namespace), type: String(r.step_type), route: String((r.output as Record<string, unknown>)._route) }))
  const execInsert = writes.find((w) => w.table === 'workflow_executions' && w.op === 'insert')
  const execRow = ((execInsert?.values as Array<Record<string, unknown>>) ?? [])[0] ?? {}
  // The node the engine itself recorded as final, when it finalized the execution.
  const finalized = writes
    .filter((w) => w.table === 'workflow_executions' && w.op === 'update')
    .map((w) => w.values as Record<string, unknown>)
    .find((v) => v && 'final_node_namespace' in v)

  return {
    id: who.id,
    workflow_id: def.id,
    workflow_name: def.name,
    variant: who.variant,
    run_kind: who.kind,
    trigger: { source: execRow.source ?? null, trigger_payload: execRow.trigger_payload ?? null, code: run.codeTrigger },
    routes,
    nodes_executed: stepRows.map((r) => String(r.step_namespace)),
    final_node: finalized ? ((finalized.final_node_namespace as string | null) ?? null) : stepRows.length ? String(stepRows[stepRows.length - 1].step_namespace) : null,
    response: run.response,
    outbound: run.outbound,
    code_dispatch: run.codeDispatch,
    supabase_writes: writes,
    do_state: await dumpDurableObjects(e),
    kv_state: await dumpKv(e),
    ...(run.error ? { error: run.error } : {}),
  }
}

export interface RunResult {
  db: ReturnType<typeof createSupabaseDouble>
  response: FixtureRecord['response']
  /** Real milliseconds from calling the engine to its answer, post-response work excluded. */
  answeredMs: number | null
  error?: string
  outbound: OutboundRecord[]
  codeDispatch: CodeDispatchRecord[]
  codeTrigger: unknown
  unstubbed: string[]
  /** Engine timers that fired although lifted (#1872); always empty when the run kept real timers. */
  timersFired: FiredTimer[]
}

/** Which run: the fixture it records, the seed its randomness and code draw from, its kind, and the test bundle a test run dispatches to. */
export interface RunSpec { id: string; seed: string; kind: RunKind; testBundle?: string; compareBundle?: string }

/**
 * What a caller may change about one run. `runtime` replaces the runtime the
 * engine is given (default: the bidding Worker's, over this run's Supabase
 * double), so the outage drill can hand it a lead client over a failing network,
 * an observer and an injected clock (#1305).
 */
export interface RunHooks {
  runtime?: (db: ReturnType<typeof createSupabaseDouble>) => unknown
  /**
   * Runs inside the run, with its network stubbed and its clock pinned, just
   * before the engine is called: the drill warms the stored copies here with the
   * Worker's own prewarm cron, as production does every minute.
   */
  before?: (runEnv: Record<string, unknown>, db: ReturnType<typeof createSupabaseDouble>) => Promise<void>
  /**
   * How long the run's post-response work (its waitUntil promises) may take after
   * the answer, as Cloudflare cuts it 30 s after the response. Unset, it is waited
   * for to the end. The drill's hung shape bounds it (#1851): work stuck on a hung
   * database is logging the outage may lose, not the answer.
   */
  postResponseLimitMs?: number
  /**
   * Holds every table read (not rpc calls) this long (#1872), to prove a replay gives the same
   * record however slow its reads are. The wait uses the harness's own timer, which
   * a run's lifted engine timers cannot stretch.
   */
  dbReadDelayMs?: number
  /**
   * Whether the engine's own timers race the runner (#1872). The replay lifts them
   * (the default), because a budget in code running out on a slow runner made base
   * and head differ with nothing changed. The outage drill keeps them real: its hung
   * database ends only when the caller's own deadline aborts the read.
   */
  engineTimers?: 'lifted' | 'real'
}

/** One execution of a workflow through the engine under test, with everything it did recorded. */
export async function runOnce(e: GateEnv, def: DefinitionFile, spec: RunSpec, payload: unknown, variant: Variant, arms: Arms, shape: WorkflowShape, hooks: RunHooks = {}): Promise<RunResult> {
  const { id, seed } = spec
  // Refused before anything global is replaced (#1872): waitAtMost cuts post-response
  // work with a timer the lift would raise to the gate deadline.
  if (hooks.engineTimers !== 'real' && hooks.postResponseLimitMs !== undefined) {
    throw new Error('money gate: postResponseLimitMs needs engineTimers: real, because its cut is a timer the lift would raise to the gate deadline')
  }
  await e.GATE_IO.fetch('https://gate/begin', { method: 'POST', body: JSON.stringify({ fixture: id, arms }) })
  const unstubbed: string[] = []

  const tables = JSON.parse(JSON.stringify(snapshot.tables)) as Record<string, Row[]>
  tables.workflows = tables.workflows.map((w) => (w.id === def.id ? { ...w, definition: def.definition } : w))
  for (const [key, value] of Object.entries(variant.env ?? {})) {
    const row = tables.environment_variables.find((r) => r.key === key)
    if (row) row.value = value
    else tables.environment_variables.push({ key, value, is_secret: false, scope: 'global', organization_id: tables.workflows[0]?.organization_id, workflow_id: null })
  }
  const readDelayMs = hooks.dbReadDelayMs
  const db = createSupabaseDouble(tables, readDelayMs ? { delayRead: () => new Promise<void>((resolve) => { harnessSetTimeout(resolve, readDelayMs) }) } : {})

  // Outbound from the engine itself: recorded and answered here, never sent.
  const engineOutbound: OutboundRecord[] = []
  let currentStep = '(engine)'
  const codeDispatch: CodeDispatchRecord[] = []
  let codeTrigger: unknown = null
  let lifted: LiftedTimers | null = null
  let timersFired: FiredTimer[]
  let response: FixtureRecord['response'] = { status: 0, body: null }
  let answeredMs: number | null = null
  let error: string | undefined
  const realFetch = globalThis.fetch
  // Everything below replaces something global, so all of it sits inside the try
  // whose finally puts it back: a setup step that throws still restores it, and its
  // error still fails the replay, rather than leaking into the next fixture.
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      const headers: Record<string, string> = {}
      req.headers.forEach((v, k) => { headers[k] = v })
      const text = await readBodyText(req)
      const body = parseBody(text, req.headers.get('content-type'))
      engineOutbound.push({ via: 'engine', node: currentStep, method: req.method, host: url.host, path: redactPathAndQuery(url), headers: redactHeaders(headers), body: redactBody(body) })
      const stubReq = { method: req.method, url, headers, body }
      const hit = stubAnswer(stubReq, arms)
      if (!hit) unstubbed.push(`${url.host}${url.pathname} (${id})`)
      const a = hit?.answer ?? noRuleAnswer(stubReq)
      return toResponse(a)
    })

    // Engine log lines name the step running, which attributes an engine side request.
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      const first = args[0]
      if (typeof first === 'string' && first.startsWith('{')) {
        try {
          const ev = JSON.parse(first) as { event?: string; step_namespace?: string }
          if (ev.event === 'step_start' && ev.step_namespace) currentStep = ev.step_namespace
        } catch { /* not an engine event */ }
      }
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})

    // A fake on every dispatch namespace binding: records the binding, its namespace
    // and the script each call resolves to, and forwards to the bundle GATE_IO hosts
    // under that name.
    let dispatchCount = 0
    const loaders: Record<string, unknown> = {}
    for (const ns of DISPATCH_NAMESPACES) {
      loaders[ns.binding] = {
        get(name: string) {
          return {
            async fetch(input: string, init?: RequestInit) {
              const path = new URL(input).pathname
              const bodyText = typeof init?.body === 'string' ? init.body : ''
              const parsed = (bodyText ? JSON.parse(bodyText) : {}) as { chain?: Array<{ namespace: string }>; payload?: unknown; execution?: unknown }
              const namespaces = parsed.chain ? parsed.chain.map((c) => c.namespace) : [path.replace(/^\/execute\//, '')]
              codeDispatch.push({ binding: ns.binding, dispatch_namespace: ns.namespace, name, path, namespaces })
              if (codeTrigger === null) codeTrigger = { payload: parsed.payload, execution: parsed.execution }
              const res = await e.GATE_IO.fetch(`https://gate/dispatch?name=${encodeURIComponent(name)}&namespace=${encodeURIComponent(ns.namespace)}&path=${encodeURIComponent(path)}&node=${encodeURIComponent(namespaces.join(','))}`, {
                method: 'POST',
                headers: { 'x-money-gate-seed': `${seed}#${dispatchCount++}` },
                body: bodyText,
              })
              if (res.headers.get('x-money-gate') === 'worker-not-found') throw new Error(`Worker not found: ${name}`)
              return res
            },
          }
        },
      }
    }

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(FIXED_TIME_MS))
    pinRandomness(seed)

    const partnerSecrets = (snapshot.tables.partner_configs ?? []).map((p) => p.cf_secret_key).filter((k): k is string => typeof k === 'string' && k.length > 0)
    const runEnv = buildEnv(e, loaders, def, partnerSecrets)
    const start = { workflowId: def.id, payload, source: variant.source ?? shape.sources?.[0] ?? 'money-gate' }
    // A test run carries what only the Test Runner supplies: the id the canvas mints
    // (a UUIDv7, here under the pinned clock and randomness), the test bundle and the
    // canvas definition.
    const options = runOptions(
      spec.kind,
      start,
      spec.kind === 'test'
        ? { executionId: uuidv7(), codeBundleName: spec.testBundle ?? null, definitionOverride: def.definition }
        : spec.kind === 'shadow_dry_run'
          ? { codeBundleName: spec.compareBundle ?? null }
          : {},
    )
    try {
      if (hooks.engineTimers !== 'real') lifted = liftEngineTimers(globalThis as unknown as TimerHost)
      const ctx = createExecutionContext()
      // The runtime the bidding Worker's routes pass, built by the engine under test.
      if (hooks.before) await hooks.before(runEnv, db)
      const runtime = hooks.runtime ? hooks.runtime(db) : moneyRuntime(db.client as never)
      // Real time (Date is pinned during a run): how long the caller waited for its answer.
      const calledAt = performance.now()
      const result = await executeWorkflow(options as never, runEnv as never, runtime as never, ctx)
      answeredMs = performance.now() - calledAt
      const settled = waitOnExecutionContext(ctx)
      if (hooks.postResponseLimitMs === undefined) {
        await settled
      } else {
        await waitAtMost(settled, hooks.postResponseLimitMs)
      }
      response = { status: result.status, body: result.response, headers: result.responseHeaders }
    } catch (err) {
      // The engine's own failure is part of the record; a setup failure above is not.
      error = err instanceof Error ? `${err.name}: ${err.message}` : 'non Error thrown'
    }
  } finally {
    timersFired = lifted?.fired() ?? []
    lifted?.restore()
    globalThis.fetch = realFetch
    vi.useRealTimers()
    // Every spy: the console, and the seeded randomness pinRandomness installed.
    vi.restoreAllMocks()
  }

  const drained = await (await e.GATE_IO.fetch('https://gate/drain')).json<{ outbound: OutboundRecord[]; unstubbed: string[] }>()
  return {
    db,
    response,
    answeredMs,
    error,
    outbound: [...engineOutbound, ...drained.outbound],
    codeDispatch,
    codeTrigger,
    unstubbed: [...unstubbed, ...drained.unstubbed],
    timersFired,
  }
}
