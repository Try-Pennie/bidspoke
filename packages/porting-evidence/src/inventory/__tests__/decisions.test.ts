import { describe, expect, it } from 'vitest'
import { applyDecisions, planDecision, type DecisionTarget, type Decisions, type DroppedStep, type Retirement } from '../decisions.ts'
import { BIDSPOKE_OWNED_COLUMNS, INVENTORY_COLUMNS } from '../plan-load.ts'
import { readExport } from '../read-export.ts'
import { PLAN_ORDER, deriveOrder, unlockItems, unlockTable } from '../unlock.ts'
import { codeStep, registryStep, workflowFile, writeExport } from './fixture.ts'

const NOW = '2026-10-28T12:00:00.000Z'

const retirement = (hashid: string): Retirement => ({ pipedream_hashid: hashid, retired_by: 'Test person', retired_reason: 'Behind an End Workflow', retired_at: NOW })
const drop = (hashid: string, step: string): DroppedStep => ({ pipedream_hashid: hashid, step, dropped_by: 'Test person', reason: 'Reads a deleted thread', dropped_at: NOW })

// Four switched on workflows: one plain, one whose only code import sits in a step
// to be dropped (in a deployment branch), one needing schedules, one to retire.
function exported() {
  return readExport(writeExport([{
    projectHashid: 'proj_A',
    workflows: [
      { hashid: 'p_plain', file: workflowFile('p_plain', { steps: [registryStep('reply', 'http-return-http-response')] }) },
      {
        hashid: 'p_thread',
        file: workflowFile('p_thread', {
          steps: [codeStep('shape', 'export default defineComponent({ async run() { return 1 } })')],
          deployments: { d1: { steps: [codeStep('normalize_thread_id', 'import OpenAI from "openai"'), registryStep('stop', 'end-end-workflow')] } },
        }),
      },
      { hashid: 'p_timer', file: workflowFile('p_timer', { triggers: [{ type: 'timer' }] }) },
      { hashid: 'p_dead', file: workflowFile('p_dead', { steps: [codeStep('assistant', 'import OpenAI from "openai"')] }) },
    ],
  }])).flatMap((p) => p.workflows)
}

describe('the loader and a person\'s decisions never share a column (#2979)', () => {
  it('leaves every column a decision writes out of what a load writes, so a reload keeps the decision', () => {
    for (const c of ['porting_stage', 'retired_by', 'retired_reason', 'retired_at', 'cut_over_at']) expect(BIDSPOKE_OWNED_COLUMNS).toContain(c)
    expect(INVENTORY_COLUMNS.filter((c) => (BIDSPOKE_OWNED_COLUMNS as readonly string[]).includes(c))).toEqual([])
  })
})

describe('applyDecisions (#2979)', () => {
  it('leaves a retired workflow out of the unlock table and the build order', () => {
    const decided = applyDecisions(exported(), { retired: [retirement('p_dead')], dropped: [] })
    expect(decided.workflows.map((w) => w.hashid)).toEqual(['p_plain', 'p_thread', 'p_timer'])
    expect(decided.retired.map((r) => r.pipedream_hashid)).toEqual(['p_dead'])
    const items = unlockItems(decided.workflows)
    expect(items.map((i) => i.hashid)).not.toContain('p_dead')
    expect(unlockTable(items, PLAN_ORDER).at(-1)?.unlocked).toBe(3)
  })

  it('leaves a dropped step out of what its workflow needs, in a deployment branch too', () => {
    const before = unlockItems(applyDecisions(exported(), { retired: [], dropped: [] }).workflows)
    expect([...before.find((i) => i.hashid === 'p_thread')!.needs]).toEqual(['code_runtime'])

    const decided = applyDecisions(exported(), { retired: [], dropped: [drop('p_thread', 'normalize_thread_id')] })
    const items = unlockItems(decided.workflows)
    expect([...items.find((i) => i.hashid === 'p_thread')!.needs]).toEqual([])
    expect(unlockTable(items, PLAN_ORDER)[0].newly).toContain('p_thread')
    expect(decided.dropped).toEqual([drop('p_thread', 'normalize_thread_id')])
    const steps = decided.workflows.find((w) => w.hashid === 'p_thread')!.workflow!
    expect(steps.deployments!.d1.steps!.map((s) => s.namespace)).toEqual(['stop'])
    expect(steps.steps.map((s) => s.namespace)).toEqual(['shape'])
  })

  it('changes the derived build order when the decisions take away what pulled a capability forward', () => {
    const all = exported()
    // Two workflows need the code runtime and one needs schedules, so the code runtime leads.
    expect(deriveOrder(unlockItems(applyDecisions(all, { retired: [], dropped: [] }).workflows))[0]).toBe('code_runtime')
    // Retire one and drop the other's step, and schedules lead instead.
    const decisions: Decisions = { retired: [retirement('p_dead')], dropped: [drop('p_thread', 'normalize_thread_id')] }
    expect(deriveOrder(unlockItems(applyDecisions(all, decisions).workflows))[0]).toBe('schedules')
  })

  it('does not change the export it was given', () => {
    const all = exported()
    const copy = JSON.stringify(all)
    applyDecisions(all, { retired: [retirement('p_dead')], dropped: [drop('p_thread', 'normalize_thread_id')] })
    expect(JSON.stringify(all)).toBe(copy)
  })

  it('names a dropped step this export does not hold rather than leaving out nothing silently', () => {
    const decided = applyDecisions(exported(), { retired: [], dropped: [drop('p_thread', 'renamed_step'), drop('p_gone', 'a_step')] })
    expect(decided.dropped).toEqual([])
    expect(decided.unmatched).toEqual([drop('p_gone', 'a_step'), drop('p_thread', 'renamed_step')])
  })
})

const target = (stage: string, dropped: DroppedStep[] = []): DecisionTarget => ({
  row: { pipedream_hashid: 'p_thread', name: 'Thread workflow', porting_stage: stage, retired_by: stage === 'retired' ? 'Test person' : null, retired_reason: stage === 'retired' ? 'Dead' : null, retired_at: stage === 'retired' ? NOW : null },
  dropped,
})

describe('planDecision (#2979)', () => {
  it('retires a workflow not yet ported, with who, why and when', () => {
    const plan = planDecision({ kind: 'retire', hashid: 'p_thread', by: ' Test person ', reason: 'Behind an End Workflow' }, target('none'), null, NOW)
    expect(plan.write).toEqual({ kind: 'retire', hashid: 'p_thread', set: { porting_stage: 'retired', retired_by: 'Test person', retired_reason: 'Behind an End Workflow', retired_at: NOW } })
    expect(plan.describe).toContain('p_thread')
  })

  it('refuses to retire without who decided or why', () => {
    expect(() => planDecision({ kind: 'retire', hashid: 'p_thread', by: ' ', reason: 'Dead' }, target('none'), null, NOW)).toThrow(/who decided/)
    expect(() => planDecision({ kind: 'retire', hashid: 'p_thread', by: 'Test person', reason: '' }, target('none'), null, NOW)).toThrow(/why/)
  })

  it('refuses a workflow the inventory does not hold, and one already past none', () => {
    expect(() => planDecision({ kind: 'retire', hashid: 'p_thread', by: 'A', reason: 'B' }, { row: null, dropped: [] }, null, NOW)).toThrow(/not in porting.pipedream_inventory/)
    expect(() => planDecision({ kind: 'retire', hashid: 'p_thread', by: 'A', reason: 'B' }, target('drafted'), null, NOW)).toThrow(/drafted/)
    expect(() => planDecision({ kind: 'retire', hashid: 'p_thread', by: 'A', reason: 'B' }, target('retired'), null, NOW)).toThrow(/already retired by Test person/)
  })

  it('undoes a retirement only on a retired workflow', () => {
    expect(planDecision({ kind: 'unretire', hashid: 'p_thread' }, target('retired'), null, NOW).write).toEqual({ kind: 'unretire', hashid: 'p_thread' })
    expect(() => planDecision({ kind: 'unretire', hashid: 'p_thread' }, target('none'), null, NOW)).toThrow(/not retired/)
  })

  it('drops a step the export holds, once', () => {
    const plan = planDecision({ kind: 'drop_step', hashid: 'p_thread', step: 'normalize_thread_id', by: 'Test person', reason: 'Reads a deleted thread' }, target('none'), ['shape', 'normalize_thread_id'], NOW)
    expect(plan.write).toEqual({ kind: 'drop_step', row: drop('p_thread', 'normalize_thread_id') })
    expect(() => planDecision({ kind: 'drop_step', hashid: 'p_thread', step: 'normalize_thread_id', by: 'A', reason: 'B' }, target('none', [drop('p_thread', 'normalize_thread_id')]), ['normalize_thread_id'], NOW)).toThrow(/already dropped by Test person/)
  })

  it('refuses to drop a step the export does not hold, or without who and why', () => {
    expect(() => planDecision({ kind: 'drop_step', hashid: 'p_thread', step: 'typo_step', by: 'A', reason: 'B' }, target('none'), ['shape'], NOW)).toThrow(/typo_step.*not a step/)
    expect(() => planDecision({ kind: 'drop_step', hashid: 'p_thread', step: 'shape', by: 'A', reason: 'B' }, target('none'), null, NOW)).toThrow(/not in the export/)
    expect(() => planDecision({ kind: 'drop_step', hashid: 'p_thread', step: 'shape', by: '', reason: 'B' }, target('none'), ['shape'], NOW)).toThrow(/who decided/)
  })

  it('keeps a step again only when it was dropped', () => {
    expect(planDecision({ kind: 'keep_step', hashid: 'p_thread', step: 'shape' }, target('none', [drop('p_thread', 'shape')]), null, NOW).write).toEqual({ kind: 'keep_step', hashid: 'p_thread', step: 'shape' })
    expect(() => planDecision({ kind: 'keep_step', hashid: 'p_thread', step: 'shape' }, target('none'), null, NOW)).toThrow(/not dropped/)
  })
})
