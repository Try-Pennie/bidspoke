import { describe, it, expect } from 'vitest'
import { deriveWatchedFields, deriveWatchedFieldMap } from '../watched-fields'
import { computeFieldPresence } from '../field-presence'
import { scopeSteps } from '../nodes/code'
import type { StepOutput, WorkflowDefinition } from '../../types'

// @ts-expect-error Vite resolves the ?raw suffix to the file's text; there is no
// ambient declaration for it in this package.
import ENGINE_FIXTURE_RAW from '../../../money-gate/fixtures/definitions/da82a183-1a4a-417e-b0b8-5f3fe5e14840.json?raw'

/**
 * #1802. The code sandbox builds `steps.trigger` as `{ payload }` and the
 * finalize-time field-presence capture reads the run's real step outputs
 * (`ctx.steps`), which never carry a `trigger` namespace. So a watched field
 * rooted at `trigger` can never be judged: `computeFieldPresence` skips it and
 * it sits in the manifest reading as present on 0 of every run (0 of 316 on
 * 2026-10-05), which the day-one-dead check reports as a dead field. A read the
 * sandbox resolves at runtime but the capture cannot see is not a watchable
 * field, so the derivation must not emit it.
 */

function def(nodes: WorkflowDefinition['nodes'], edges: WorkflowDefinition['edges'] = []): WorkflowDefinition {
  return { nodes, edges } as WorkflowDefinition
}

function codeNode(namespace: string, script: string) {
  return { id: namespace, namespace, type: 'code', config: { script } } as WorkflowDefinition['nodes'][number]
}

describe('deriveWatchedFields trigger handling (#1802)', () => {
  it('drops a code-node read rooted at the trigger payload, keeping real step reads', () => {
    const fields = deriveWatchedFields(
      def([
        codeNode(
          'parse',
          'const id = steps.trigger.payload.leadUuid;\nconst score = steps.prev.output.score;\nreturn { id, score };',
        ),
      ]),
    )
    expect(fields).toContain('prev.score')
    expect(fields.filter((f) => f === 'trigger' || f.startsWith('trigger.'))).toEqual([])
  })

  it('drops every nested trigger.payload read a script makes', () => {
    const fields = deriveWatchedFields(
      def([
        codeNode(
          'prospect',
          'const first = steps.trigger.payload.personalInformation.firstName;\n' +
            'const sub = steps.trigger.payload.subAccountUuid;\n' +
            'return { first, sub };',
        ),
      ]),
    )
    expect(fields.some((f) => f.startsWith('trigger'))).toBe(false)
  })

  it('emits zero trigger-rooted fields for the live Engine Bidding Workflow', () => {
    // Non-vacuous: the fixture genuinely reads steps.trigger.payload (if it did
    // not, the empty assertion below would pass whether or not the drop works).
    // So this proves the derivation drops a trigger read that really exists in
    // the live source, not merely that the source never read trigger.
    expect(ENGINE_FIXTURE_RAW as string).toContain('steps.trigger.payload.leadUuid')
    const raw = JSON.parse(ENGINE_FIXTURE_RAW as string) as { definition: WorkflowDefinition }
    const fields = deriveWatchedFields(raw.definition)
    const triggerRooted = fields.filter((f) => f === 'trigger' || f.startsWith('trigger.'))
    expect(triggerRooted).toEqual([])
    // The derivation still reads the rest of the tree: real step reads survive.
    expect(fields.length).toBeGreaterThan(0)
  })

  it('does not label any trigger-rooted field in the full map', () => {
    expect(ENGINE_FIXTURE_RAW as string).toContain('steps.trigger.payload')
    const raw = JSON.parse(ENGINE_FIXTURE_RAW as string) as { definition: WorkflowDefinition }
    const { fields } = deriveWatchedFieldMap(raw.definition)
    expect(fields.some((f) => f.path === 'trigger' || f.path.startsWith('trigger.'))).toBe(false)
  })
})

describe('sandbox trigger shape grounds the drop (#1802)', () => {
  const steps: Record<string, StepOutput> = {
    prev: { output: { score: 720 }, status: 'completed' },
  }

  it('builds steps.trigger as { payload } only, with no event or context the ported scripts could read', () => {
    const trigger = scopeSteps(steps, { leadUuid: 'L1' }, null).trigger as Record<string, unknown>
    expect(trigger).toEqual({ payload: { leadUuid: 'L1' } })
    expect('event' in trigger).toBe(false)
    expect('context' in trigger).toBe(false)
  })

  it('field-presence cannot judge a trigger field, because the captured steps carry no trigger namespace', () => {
    // The capture is fed the run's real step outputs, which never include trigger.
    const presence = computeFieldPresence(steps, ['trigger.payload.leadUuid', 'prev.score'])
    expect(presence).toEqual({ 'prev.score': true })
    expect('trigger.payload.leadUuid' in presence).toBe(false)
  })
})
