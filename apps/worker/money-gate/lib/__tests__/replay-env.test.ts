/**
 * The replay's plan and environment (#1730): which fixtures run as which kind of
 * run, and that every dispatch namespace the engine under test declares is the
 * recording fake rather than whatever the test runner built for it.
 */
import { describe, it, expect } from 'vitest'
import { buildEnv, runPlan, type VariantFile } from '../../harness/replay-env'

const file = (variants: VariantFile['variants']): VariantFile => ({ workflow_id: 'w', workflow_name: 'W', variants })

describe('runPlan', () => {
  it('replays every variant live, and a variant as each further kind it opts into, right after its live run', () => {
    const plan = runPlan(file([{ name: 'a' }, { name: 'b', also_run_as: ['test', 'shadow_dry_run'] }, { name: 'c' }]))
    expect(plan.map((p) => `${p.variant.name} ${p.kind}`)).toEqual(['a live', 'b live', 'b test', 'b shadow_dry_run', 'c live'])
  })

  it('gives a workflow with no variant file its shape default in every kind, so no workflow goes untested as a test or shadow run', () => {
    expect(runPlan(undefined).map((p) => `${p.variant.name} ${p.kind}`)).toEqual(['shape_default live', 'shape_default test', 'shape_default shadow_dry_run'])
  })

  it('folds the file common part into the variant, as the live replay always has', () => {
    const plan = runPlan({ ...file([{ name: 'b', also_run_as: ['test'] }]), common: { set: { 'x.y': 1 } } })
    expect(plan.map((p) => p.variant.set)).toEqual([{ 'x.y': 1 }, { 'x.y': 1 }])
  })
})

describe('buildEnv', () => {
  const realBinding = { get: () => 'the runner built this, not the gate' }

  it('puts the recording fake on every dispatch namespace binding and copies none of the real ones', () => {
    const moneyFake = { fake: 'money' }
    const compareFake = { fake: 'compare' }
    const out = buildEnv(
      { DYNAMIC_WORKER_LOADER: realBinding, COMPARE_CODE_LOADER: realBinding, WORKFLOW_CACHE: { kv: true }, GATE_IO: {} },
      { DYNAMIC_WORKER_LOADER: moneyFake, COMPARE_CODE_LOADER: compareFake },
      { definition: {} },
    )
    expect(out.DYNAMIC_WORKER_LOADER).toBe(moneyFake)
    expect(out.COMPARE_CODE_LOADER).toBe(compareFake)
    expect(out.WORKFLOW_CACHE).toEqual({ kv: true })
    expect(out).not.toHaveProperty('GATE_IO')
  })
})
