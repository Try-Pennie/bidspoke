import { describe, expect, it } from 'vitest'
import { isConditionValueReference } from '@bidspoke/workflow-definition'
import { committedDefinitions, definitionsIn, type CommittedDefinition } from './_committed-definitions'

/**
 * #2588 taught gt, gte, lt and lte to resolve a `steps.`, `trigger.` or `env.`
 * reference on the value side, as in_array always has. Before, such a value was
 * compared as a literal: Number('steps.x') is NaN, so the condition was always
 * false. A definition holding one would change behaviour the day this shipped.
 *
 * On 2026-10-21 none did: 44 numeric conditions across the five live workflows
 * and 18 across deleted ones, with string values only "0" and "9999" (read only
 * query over workflows.definition). This guard keeps the committed copies
 * measured the same way, so the claim "no Filter or Branch changes behaviour"
 * rests on a count, and a fixture refreshed with such a value is caught.
 */

const NUMERIC = new Set(['gt', 'gte', 'lt', 'lte'])

interface NumericCondition {
  file: string
  operator: string
  value: unknown
}

/** Every `{ field, operator, value }` with a numeric operator, at any depth of the definition. */
function numericConditions(def: CommittedDefinition): NumericCondition[] {
  const out: NumericCondition[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (v === null || typeof v !== 'object') return
    const obj = v as Record<string, unknown>
    if ('field' in obj && typeof obj.operator === 'string' && NUMERIC.has(obj.operator)) {
      out.push({ file: def.file, operator: obj.operator, value: obj.value })
    }
    for (const key of Object.keys(obj)) walk(obj[key])
  }
  walk(def.root)
  return out
}

const referenceLooking = (conditions: NumericCondition[]) =>
  conditions.filter((c) => isConditionValueReference(c.value))

describe('numeric conditions in committed definitions hold literal values (#2588)', () => {
  const definitions = committedDefinitions()
  const conditions = definitions.flatMap(numericConditions)

  it('finds the committed definitions and their numeric conditions, so a pass is not vacuous', () => {
    expect(definitions.length, 'no committed definitions found').toBeGreaterThan(0)
    const files = new Set(definitions.map((d) => d.file))
    for (const id of ['6624acd0', 'e1b810da', '89b1a6af', 'da82a183']) {
      expect([...files].some((f) => f.includes(`money-gate/fixtures/definitions/${id}`)), id).toBe(true)
    }
    expect(conditions.length, 'no numeric conditions found in any committed definition').toBeGreaterThan(0)
  })

  it('no numeric condition has a value that now resolves as a reference', () => {
    expect(referenceLooking(conditions)).toEqual([])
  })

  it('the scan finds a reference-looking value when one is seeded (positive control)', () => {
    const seeded = definitionsIn({
      definition: {
        nodes: [{
          type: 'branch',
          config: { branches: [{ label: 'a', condition: { groups: [{ conditions: [
            { field: 'trigger.payload.amount', operator: 'lte', value: 'steps.constants.output.maximumLoanAmount' },
            { field: 'trigger.payload.amount', operator: 'gt', value: '9999' },
          ], logic: 'AND' }], logic: 'AND' } }] },
        }],
        edges: [{ id: 'e', source: 'a', target: 'b', condition: { groups: [{ conditions: [
          { field: 'trigger.payload.score', operator: 'gte', value: 'env.MIN_SCORE' },
        ], logic: 'AND' }], logic: 'AND' } }],
      },
    }, 'seeded.json')
    const found = referenceLooking(seeded.flatMap(numericConditions))
    expect(found.map((c) => c.value)).toEqual(['steps.constants.output.maximumLoanAmount', 'env.MIN_SCORE'])
  })
})
