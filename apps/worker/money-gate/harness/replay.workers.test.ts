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
import { env, reset } from 'cloudflare:test'
import { it, expect } from 'vitest'
import { CLICK_CHECK_BUDGET_MS } from '@bidspoke/buyer-profile'
import { scanForPersonalData } from '../lib/fixture-scan'
import { generatePayload } from '../lib/generate'
import { describeFiredTimers } from '../lib/engine-timers'
import { compareTranscripts, formatDifferences, type FixtureRecord, type Transcript } from '../lib/compare'
import type { WorkflowShape } from '../lib/shape'
import { fixtureId } from '../lib/run-kinds'
import { FIXED_TIME_MS, runPlan } from './replay-env'
import { armsOf, definitions, hostBundles, recordFixture, runOnce, shapes, variantFiles, type GateEnv } from './replay-core'

it('replays every fixture through the engine under test and writes the transcript', async () => {
  const e = env as unknown as GateEnv
  try {
    await replayAll(e)
  } finally {
    await e.GATE_IO.fetch('https://gate/dispose', { method: 'POST' })
  }
}, 900_000)

async function replayAll(e: GateEnv): Promise<void> {
  const { testBundles, compareBundles } = await hostBundles(e)

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
        const prior = await runOnce(e, def, { id: `${id}#prior${i}`, seed: `${seed}#prior${i}`, kind: 'live' }, payload, variant, variant.prior_stubs ?? variant.stubs ?? {}, shape)
        expect(prior.timersFired, describeFiredTimers(`${id}#prior${i}`, prior.timersFired)).toEqual([])
      }

      const run = await runOnce(e, def, { id, seed, kind, testBundle: testBundles.get(def.id), compareBundle: compareBundles.get(def.id) }, payload, variant, variant.stubs ?? {}, shape)
      // An engine timer that fires decided the record by how long the run took (#1872).
      expect(run.timersFired, describeFiredTimers(id, run.timersFired)).toEqual([])
      for (const u of run.unstubbed) unstubbed.add(u)
      for (const t of run.db.unknownTables()) unknownTables.add(t)
      for (const q of run.db.unsupportedFilters()) unsupportedQueries.add(q)
      fixtures.push(await recordFixture(e, def, { id, variant: variant.name, kind }, run))
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

/**
 * The same lead twice through the engine under test, once as usual and once with
 * every database read held past the click check's 800 ms budget (#1872). A replay
 * that depends on how fast it runs gave base and head different answers with
 * nothing changed, so the two records here must be identical. The fixture is the
 * one that flipped on 2026-10-07: a known no from Tripoint offered to the click
 * buyer. It runs on both sides, so each engine is shown to answer the same under
 * the harness the gate compares them with.
 */
it('gives the same record however slow the database is', async () => {
  const e = env as unknown as GateEnv
  const workflow = 'Engine Bidding Workflow'
  const variantName = 'tripoint_declined_click_eligible'
  // Each held read alone outlasts the budget, so a budget still racing the clock
  // cannot finish inside it.
  const slowReadMs = CLICK_CHECK_BUDGET_MS + 200
  try {
    await hostBundles(e)
    const def = definitions.find((d) => d.name === workflow)
    expect(def, `no committed definition named ${workflow}`).toBeDefined()
    const shape = shapes.workflows.find((w) => w.workflow_id === def!.id) as WorkflowShape | undefined
    expect(shape, `no shape for ${workflow}`).toBeDefined()
    const planned = runPlan(variantFiles.find((v) => v.workflow_id === def!.id)).find((p) => p.variant.name === variantName && p.kind === 'live')
    expect(planned, `${workflow} has no live variant named ${variantName}`).toBeDefined()
    const variant = planned!.variant
    const id = fixtureId(def!.name, variant.name, 'live')
    const payload = generatePayload(shape!, { seed: id, set: variant.set, unset: variant.unset })

    const record = async (dbReadDelayMs: number | undefined): Promise<{ fixture: FixtureRecord; answeredMs: number | null }> => {
      await reset()
      const run = await runOnce(e, def!, { id, seed: id, kind: 'live' }, payload, variant, variant.stubs ?? {}, shape!, { dbReadDelayMs })
      expect(run.timersFired, describeFiredTimers(id, run.timersFired)).toEqual([])
      return { fixture: await recordFixture(e, def!, { id, variant: variant.name, kind: 'live' }, run), answeredMs: run.answeredMs }
    }
    const quick = await record(undefined)
    const slow = await record(slowReadMs)

    // The control: the usual run offers the click buyer, so a slow run that did not
    // is a real difference, and the slow run really was held past the budget.
    expect(quick.fixture.routes.find((r) => r.namespace === 'buyer_click_check')?.route, 'the usual run did not reach the click offer, so this check proves nothing').toBe('eligible')
    expect(slow.answeredMs ?? 0, 'the slow run was not held past the click check budget').toBeGreaterThan(CLICK_CHECK_BUDGET_MS)

    const transcript = (side: 'base' | 'head', fixture: FixtureRecord): Transcript => ({ version: 1, side, fixtures: [fixture], workflows: [], unstubbed_hosts: [], unknown_tables: [] })
    const differences = compareTranscripts(transcript('base', quick.fixture), transcript('head', slow.fixture))
    expect(differences, `a slow database changed what the engine did, so the gate depends on how fast the runner is:\n${formatDifferences(differences)}`).toEqual([])
  } finally {
    await e.GATE_IO.fetch('https://gate/dispose', { method: 'POST' })
  }
}, 900_000)

/**
 * A run asking for a real timer cut (postResponseLimitMs) while its engine timers
 * are lifted is refused before anything global is replaced (#1872), so a caller's
 * mistake cannot leave the next run with this one's fetch, clock or console.
 */
it('refuses a lifted run with a post-response cut before it touches anything global', async () => {
  const e = env as unknown as GateEnv
  const def = definitions[0]
  const shape = shapes.workflows.find((w) => w.workflow_id === def.id) as WorkflowShape
  const fetchBefore = globalThis.fetch
  await expect(runOnce(e, def, { id: 'refused', seed: 'refused', kind: 'live' }, {}, { name: 'refused' }, {}, shape, { postResponseLimitMs: 1 }))
    .rejects.toThrow('postResponseLimitMs needs engineTimers: real')
  expect(globalThis.fetch).toBe(fetchBefore)
  expect(Date.now()).not.toBe(FIXED_TIME_MS)
})
