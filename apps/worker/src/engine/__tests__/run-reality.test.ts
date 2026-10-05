/**
 * The one module that says what kind of run this is (#1708, plan 0.D, R11).
 *
 * Before it, eight places in the engine each read the test flag, the shadow
 * mode or LOCAL_DEV and drew their own conclusion. The equivalence test below
 * writes each of those conclusions out as it stood, independently of the module
 * (L70), and asserts the module reaches the same answer for every combination of
 * the three inputs, so consolidating them changed nothing.
 */
import { describe, expect, it } from 'vitest'
import { NODE_TYPES } from '@bidspoke/node-types'
import { nodeReportsOnly, nodeSkipsScreen, runReality, runRealityOf, shadowRunRefusal, ShadowRunRefusedError, stampRunReality } from '../run-reality'
import type { ExecutionContext, WorkflowDefinition } from '../../types'

type Shadow = 'off' | 'dry_run' | 'stand_in' | undefined
const TESTS: (boolean | undefined)[] = [undefined, false, true]
const SHADOWS: Shadow[] = [undefined, 'off', 'dry_run', 'stand_in']
const LOCAL_DEVS: (string | undefined)[] = [undefined, '', '1', 'true']

const combos = TESTS.flatMap((isTest) => SHADOWS.flatMap((shadowMode) => LOCAL_DEVS.map((localDev) => ({ isTest, shadowMode, localDev }))))

/** The context the engine builds for those options, stamped the way it always was. */
function ctxFor(o: { isTest?: boolean; shadowMode?: Shadow }): ExecutionContext {
  const ctx: ExecutionContext = { trigger: { payload: {}, source: 's', workflow_id: 'w', org_id: 'o', trace_id: 't' }, steps: {}, env: {} }
  stampRunReality(ctx, o)
  return ctx
}

// The conclusions as each call site drew them before #1708, written out by hand.
const OLD = {
  shadowStub: (c: ExecutionContext) => c.shadow_mode === 'dry_run' || c.shadow_mode === 'stand_in',
  standIn: (c: ExecutionContext) => c.shadow_mode === 'stand_in',
  buyerReportOnly: (c: ExecutionContext, localDev: unknown) => Boolean(c.isTest) || c.shadow_mode === 'dry_run' || c.shadow_mode === 'stand_in' || Boolean(localDev),
  circuitAlertSuppressed: (c: ExecutionContext, localDev: unknown) => !!localDev || !!c.isTest,
  alertsSilent: (o: { isTest?: boolean }, localDev: unknown) => o.isTest === true || !!localDev,
  achieveUnscreened: (c: ExecutionContext) => !!c.isTest,
  sandboxShadowMode: (c: ExecutionContext) => c.shadow_mode ?? 'off',
  isTestRow: (o: { isTest?: boolean }) => o.isTest ?? false,
  // The stamp itself: only a truthy option was ever written onto the context.
  stampedShadow: (o: { shadowMode?: Shadow }) => (o.shadowMode ? o.shadowMode : undefined),
  stampedTest: (o: { isTest?: boolean }) => (o.isTest ? true : undefined),
}

describe('run reality: equivalent to every conclusion it replaced', () => {
  it.each(combos)('isTest=%s shadow=%s localDev=%s', (o) => {
    const ctx = ctxFor(o)
    const env = { LOCAL_DEV: o.localDev }
    const fromOptions = runReality({ isTest: o.isTest, shadowMode: o.shadowMode, localDev: o.localDev })
    const fromCtx = runRealityOf(ctx, env)

    expect(ctx.shadow_mode).toBe(OLD.stampedShadow(o))
    expect(ctx.isTest).toBe(OLD.stampedTest(o))
    for (const r of [fromOptions, fromCtx]) {
      expect(r.outboundStubbed).toBe(OLD.shadowStub(ctx))
      expect(r.standIn).toBe(OLD.standIn(ctx))
      expect(r.silentAlerts).toBe(OLD.alertsSilent(o, o.localDev))
      expect(r.silentAlerts).toBe(OLD.circuitAlertSuppressed(ctx, o.localDev))
      expect(r.isTest).toBe(OLD.isTestRow(o))
      expect(r.sandboxShadowMode).toBe(OLD.sandboxShadowMode(ctx))
      expect(nodeReportsOnly('buyer_select', r)).toBe(OLD.buyerReportOnly(ctx, o.localDev))
      expect(nodeReportsOnly('buyer_click_send', r)).toBe(OLD.buyerReportOnly(ctx, o.localDev))
      expect(nodeSkipsScreen('achieve_offers', r)).toBe(OLD.achieveUnscreened(ctx))
    }
  })

  it('covers all 48 combinations', () => {
    expect(combos).toHaveLength(48)
  })
})

describe('run reality: the per node exceptions are named, not scattered', () => {
  const live = runReality({ isTest: true })

  it('a test run is report only for exactly the buyer sale nodes', () => {
    expect(NODE_TYPES.filter((t) => nodeReportsOnly(t, live)).sort()).toEqual(['buyer_click_send', 'buyer_select'])
  })

  it('a test run skips the pre-send screen for exactly the Achieve node', () => {
    expect(NODE_TYPES.filter((t) => nodeSkipsScreen(t, live))).toEqual(['achieve_offers'])
  })

  it('a live run is report only and unscreened for no node', () => {
    const real = runReality({})
    expect(NODE_TYPES.filter((t) => nodeReportsOnly(t, real) || nodeSkipsScreen(t, real))).toEqual([])
  })
})

describe('run reality: a shadow run refuses a node it cannot stub (#1780)', () => {
  const definition = (...nodes: Array<{ namespace: string; type: string }>): WorkflowDefinition =>
    ({ trigger: { id: 't', type: 'trigger', config: {} }, nodes: nodes.map((n, i) => ({ id: `n${i}`, config: {}, ...n })), edges: [] }) as unknown as WorkflowDefinition
  const withCode = definition({ namespace: 'prep', type: 'transform' }, { namespace: 'equifax_pull', type: 'code' }, { namespace: 'scout', type: 'code' })

  it('refuses a dry run of a workflow carrying code nodes, naming every one and why', () => {
    const refusal = shadowRunRefusal(withCode, runReality({ isTest: true, shadowMode: 'dry_run' }))
    expect(refusal).toBeInstanceOf(ShadowRunRefusedError)
    expect(refusal?.nodes.map(({ namespace, type }) => ({ namespace, type }))).toEqual([{ namespace: 'equifax_pull', type: 'code' }, { namespace: 'scout', type: 'code' }])
    expect(refusal?.message).toBe(
      "A shadow run of this workflow is refused before anything runs. equifax_pull and scout are code nodes, and a code node's scripts make their real outbound calls on a shadow run, with nothing to stub them."
    )
  })

  it('says is for one node', () => {
    const one = definition({ namespace: 'equifax_pull', type: 'code' })
    expect(shadowRunRefusal(one, runReality({ isTest: true, shadowMode: 'dry_run' }))?.message).toContain('equifax_pull is a code node, and')
  })

  it('refuses a stand in run the same way, since it stubs no more than a dry run', () => {
    expect(shadowRunRefusal(withCode, runReality({ isTest: true, shadowMode: 'stand_in' }))).toBeInstanceOf(ShadowRunRefusedError)
  })

  it('runs a shadow of a workflow whose nodes are all stubbed or send nothing', () => {
    const stubbed = definition({ namespace: 'bids', type: 'bid_group' }, { namespace: 'sf', type: 'salesforce' }, { namespace: 'reply', type: 'response' })
    expect(shadowRunRefusal(stubbed, runReality({ isTest: true, shadowMode: 'dry_run' }))).toBeNull()
  })

  it('never refuses a run that is not a shadow, live or canvas test, which makes its real calls by design', () => {
    for (const isTest of [false, true]) {
      expect(shadowRunRefusal(withCode, runReality({ isTest, shadowMode: undefined }))).toBeNull()
      expect(shadowRunRefusal(withCode, runReality({ isTest, shadowMode: 'off' }))).toBeNull()
    }
  })

  it('leaves a type this build has never heard of to the executor, which refuses it by name', () => {
    expect(shadowRunRefusal(definition({ namespace: 'x', type: 'not_a_type' }), runReality({ isTest: true, shadowMode: 'dry_run' }))).toBeNull()
  })

  it('marks the refusal permanent, so a retry classifier never runs it again', () => {
    expect(shadowRunRefusal(withCode, runReality({ isTest: true, shadowMode: 'dry_run' }))?.permanent).toBe(true)
  })
})
