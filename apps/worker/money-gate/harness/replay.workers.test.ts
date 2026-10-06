/**
 * The money gate replay (#1704): runs every fixture through the bidding engine of
 * ONE side (the merge base or the head, chosen by MONEY_GATE_ENGINE_ROOT in
 * vitest.money-gate.config.mts) and writes what the engine sent and decided to a
 * transcript. money-gate/compare-transcripts.ts then compares the two sides.
 *
 * Real here: the engine (executeWorkflow and every node executor), Durable
 * Objects and KV (workerd, through the Vitest plugin), and code nodes (each
 * workflow's bundle, built by the engine's own buildBundledWorkerScript and hosted
 * in workerd by the GATE_IO service).
 * Doubles: Supabase (the committed config snapshot, writes recorded), every
 * outbound request (answered by money-gate/lib/stub-rules.ts), and every dispatch
 * namespace (a fake that records where each dispatch went). Network is off.
 *
 * Each lead is replayed live, and the variants that opt in are replayed again as
 * a canvas test run and as a dry_run shadow run (#1730), with the options those
 * routes pass (lib/run-kinds.ts), so base and head are compared on all three.
 */
import { env, listDurableObjectIds, runInDurableObject, createExecutionContext, waitOnExecutionContext, reset } from 'cloudflare:test'
import { it, expect, vi } from 'vitest'
import { executeWorkflow, moneyRuntime } from '@money-gate-engine/engine/index'
import { buildBundledWorkerScript, codeBundleName, deployTestCodeBundle } from '@money-gate-engine/lib/code-node-deployer'
import * as deployer from '@money-gate-engine/lib/code-node-deployer'
import { uuidv7 } from '@bidspoke/uuidv7'
import { createSupabaseDouble, type RecordedWrite, type Row } from '../lib/supabase-double'
import { generatePayload } from '../lib/generate'
import { scanForPersonalData } from '../lib/fixture-scan'
import { parseBody, redactBody, redactHeaders, redactPathAndQuery } from '../lib/redact'
import { noRuleAnswer, readBodyText, stubAnswer, toResponse, type Arms } from '../lib/stub-rules'
import type { CodeDispatchRecord, FixtureRecord, OutboundRecord, RouteRecord, Transcript, WorkflowArms } from '../lib/compare'
import type { ShapesFile, WorkflowShape } from '../lib/shape'
import type { ConfigSnapshot } from '../lib/snapshot'
import { fixtureId, runOptions, type RunKind } from '../lib/run-kinds'
import { scriptFromUpload } from '../lib/test-bundle-upload'
import { FIXED_TIME_MS, buildEnv, runPlan, type VariantFile, type Variant } from './replay-env'
import type { HostedBundle } from '../lib/hosted-bundle'
import { liftStepDeadlines } from '../lib/step-deadlines'
import shapesFile from '../fixtures/shapes.json'
import snapshotFile from '../fixtures/config-snapshot.json'

interface DefinitionFile { id: string; name: string; definition: { nodes: Array<{ id: string; namespace: string; type: string; config?: Record<string, unknown> }>; edges: Array<{ source: string; target: string; source_handle?: string }> } }

// Every timer a definition sets is lifted far above any real step, on both sides
// alike, so a slow runner can never time a step out on one side only (#1796).
const definitions = Object.values(import.meta.glob<DefinitionFile>('../fixtures/definitions/*.json', { eager: true, import: 'default' })).map(liftStepDeadlines)
const variantFiles = Object.values(import.meta.glob<VariantFile>('../fixtures/variants/*.json', { eager: true, import: 'default' }))
const shapes = shapesFile as unknown as ShapesFile
const snapshot = snapshotFile as unknown as ConfigSnapshot

/** The engine under test's dispatch namespaces, from its wrangler.toml (vitest.money-gate.config.mts). */
const DISPATCH_NAMESPACES = JSON.parse(String((env as Record<string, unknown>).MONEY_GATE_DISPATCH_NAMESPACES ?? '[]')) as Array<{ binding: string; namespace: string; outbound: string | null }>
const DISPATCH_BINDINGS = new Set(DISPATCH_NAMESPACES.map((d) => d.binding))

/**
 * Every node that routes by a handle, and its handles. `output` is the pass through
 * edge to a branch's join (or a node's fallback), never a route the node names, so it
 * is not an arm where a node has named handles. An arm no input can reach (Main
 * Flow's debt_screening else, behind a screen that already required what it lacks)
 * is listed as not reached like any other: the report says so, it does not hide it.
 */
function armsOf(def: DefinitionFile): WorkflowArms {
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
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`
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
async function holdAlarms(e: Record<string, unknown>): Promise<void> {
  for (const name of Object.keys(e).sort()) {
    if (name === 'GATE_IO' || DISPATCH_BINDINGS.has(name)) continue
    const ns = e[name] as DurableObjectNamespace
    if (!ns || typeof (ns as { idFromName?: unknown }).idFromName !== 'function') continue
    // Any object's storage reaches the prototype every object's storage shares; the
    // probe object it creates is gone with the first fixture's reset.
    await runInDurableObject(ns.get(ns.idFromName('money-gate-alarm-probe')), async (_instance: unknown, state: DurableObjectState) => {
      const proto = Object.getPrototypeOf(state.storage) as Record<string, unknown>
      platformGetAlarm ??= proto.getAlarm as typeof platformGetAlarm
      proto.setAlarm = async function (this: object, at: number | Date) {
        heldAlarms.set(this, typeof at === 'number' ? at : at.getTime())
      }
      proto.getAlarm = async function (this: object) {
        return heldAlarms.get(this) ?? null
      }
      proto.deleteAlarm = async function (this: object) {
        heldAlarms.set(this, null)
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

async function dumpDurableObjects(e: Record<string, unknown>): Promise<Record<string, unknown>> {
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
            const rows = state.storage.sql.exec(`SELECT * FROM "${String(t.name)}"`).toArray()
            tables[String(t.name)] = rows.map((r) => JSON.stringify(r)).sort()
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

async function dumpKv(e: Record<string, unknown>): Promise<Record<string, unknown>> {
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

type GateEnv = Record<string, unknown> & { GATE_IO: Fetcher }

it('replays every fixture through the engine under test and writes the transcript', async () => {
  const e = env as unknown as GateEnv
  try {
    await replayAll(e)
  } finally {
    await e.GATE_IO.fetch('https://gate/dispose', { method: 'POST' })
  }
}, 900_000)

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
  }) as typeof fetch
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

async function replayAll(e: GateEnv): Promise<void> {
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
      .filter((n) => n.type === 'code' && typeof n.config?.script === 'string' && (n.config.script as string).trim().length > 0)
      .map((n) => ({ namespace: n.namespace, script: n.config!.script as string }))
    if (scripts.length === 0) continue
    bundles.push({ name: codeBundleName(d.id), script: buildBundledWorkerScript(scripts), namespace: moneyNamespace })
    const test = await deployCaptured(e, d, 'test bundle', deployTestCodeBundle as DeployFn)
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

  const fixtures: FixtureRecord[] = []
  const unstubbed = new Set<string>()
  const unknownTables = new Set<string>()
  const unsupportedQueries = new Set<string>()

  const variantsByWorkflow = new Map(variantFiles.map((v) => [v.workflow_id, v]))
  for (const def of [...definitions].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const shape = shapes.workflows.find((w) => w.workflow_id === def.id) as WorkflowShape | undefined
    if (!shape) throw new Error(`no shape for ${def.name}; rerun scripts/export-money-fixture-shapes.ts`)
    for (const { variant, kind } of runPlan(variantsByWorkflow.get(def.id))) {
      const id = fixtureId(def.name, variant.name, kind)
      // A test or shadow fixture is the live fixture's lead, run another way: the same
      // payload, randomness and code seeds, so the two differ only in the kind of run.
      const seed = fixtureId(def.name, variant.name, 'live')
      const payload = generatePayload(shape, { seed, set: variant.set, unset: variant.unset })
      expect(scanForPersonalData(payload), `fixture ${id} carries personal data`).toEqual([])

      // Every fixture starts cold: no KV cache, no Durable Object state, so a fixture's
      // record is its own and does not depend on the order the fixtures ran in.
      await reset()

      // A prior run sets up state the recorded run meets (an earlier click on the same
      // prospect, say). It goes through the same engine and only its state is kept. It
      // stands for real traffic that came before, so it is always a live run.
      for (let i = 0; i < (variant.prior_runs ?? 0); i++) {
        await runOnce(e, def, { id: `${id}#prior${i}`, seed: `${seed}#prior${i}`, kind: 'live' }, payload, variant, variant.prior_stubs ?? variant.stubs ?? {}, shape)
      }

      const run = await runOnce(e, def, { id, seed, kind, testBundle: testBundles.get(def.id), compareBundle: compareBundles.get(def.id) }, payload, variant, variant.stubs ?? {}, shape)
      for (const u of run.unstubbed) unstubbed.add(u)
      for (const t of run.db.unknownTables()) unknownTables.add(t)
      for (const q of run.db.unsupportedFilters()) unsupportedQueries.add(q)

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

      fixtures.push({
        id,
        workflow_id: def.id,
        workflow_name: def.name,
        variant: variant.name,
        run_kind: kind,
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
      })
    }
  }

  const transcript: Transcript = {
    version: 1,
    side: (import.meta.env.MONEY_GATE_SIDE as 'base' | 'head' | undefined) ?? 'head',
    fixtures,
    workflows: definitions.map(armsOf).sort((a, b) => (a.workflow_name < b.workflow_name ? -1 : 1)),
    unstubbed_hosts: [...unstubbed].sort(),
    unknown_tables: [...unknownTables].sort(),
    unsupported_queries: [...unsupportedQueries].sort(),
  }
  const written = await e.GATE_IO.fetch('https://gate/transcript', { method: 'POST', body: JSON.stringify(transcript, null, 1) })
  expect(written.status, await written.clone().text()).toBe(200)
}

interface RunResult {
  db: ReturnType<typeof createSupabaseDouble>
  response: FixtureRecord['response']
  error?: string
  outbound: OutboundRecord[]
  codeDispatch: CodeDispatchRecord[]
  codeTrigger: unknown
  unstubbed: string[]
}

/** Which run: the fixture it records, the seed its randomness and code draw from, its kind, and the test bundle a test run dispatches to. */
interface RunSpec { id: string; seed: string; kind: RunKind; testBundle?: string; compareBundle?: string }

/** One execution of a workflow through the engine under test, with everything it did recorded. */
async function runOnce(e: GateEnv, def: DefinitionFile, spec: RunSpec, payload: unknown, variant: Variant, arms: Arms, shape: WorkflowShape): Promise<RunResult> {
  const { id, seed } = spec
  await e.GATE_IO.fetch('https://gate/begin', { method: 'POST', body: JSON.stringify({ fixture: id, arms }) })
  const unstubbed: string[] = []

  const tables: Record<string, Row[]> = JSON.parse(JSON.stringify(snapshot.tables))
  tables.workflows = tables.workflows.map((w) => (w.id === def.id ? { ...w, definition: def.definition } : w))
  for (const [key, value] of Object.entries(variant.env ?? {})) {
    const row = tables.environment_variables.find((r) => r.key === key)
    if (row) row.value = value
    else tables.environment_variables.push({ key, value, is_secret: false, scope: 'global', organization_id: tables.workflows[0]?.organization_id, workflow_id: null })
  }
  const db = createSupabaseDouble(tables)

  // Outbound from the engine itself: recorded and answered here, never sent.
  const engineOutbound: OutboundRecord[] = []
  let currentStep = '(engine)'
  const realFetch = globalThis.fetch
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
  }) as typeof fetch

  // Engine log lines name the step running, which attributes an engine side request.
  const consoleLog = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
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
  const codeDispatch: CodeDispatchRecord[] = []
  let codeTrigger: unknown = null
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
  let response: FixtureRecord['response'] = { status: 0, body: null }
  let error: string | undefined
  try {
    const ctx = createExecutionContext()
    // The runtime the bidding Worker's routes pass, built by the engine under test.
    const result = await executeWorkflow(options as never, runEnv as never, moneyRuntime(db.client as never), ctx)
    await waitOnExecutionContext(ctx)
    response = { status: result.status, body: result.response, headers: result.responseHeaders }
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : 'non Error thrown'
  } finally {
    globalThis.fetch = realFetch
    vi.useRealTimers()
    consoleLog.mockRestore()
    vi.restoreAllMocks()
  }

  const drained = (await (await e.GATE_IO.fetch('https://gate/drain')).json()) as { outbound: OutboundRecord[]; unstubbed: string[] }
  return {
    db,
    response,
    error,
    outbound: [...engineOutbound, ...drained.outbound],
    codeDispatch,
    codeTrigger,
    unstubbed: [...unstubbed, ...drained.unstubbed],
  }
}
