/**
 * Guard (#2590, #2588): the settled lead validation designs, docs/design/lead-validation-node.html
 * (the settings panel) and docs/design/lead-validation-node-card.html (the canvas card), carry one
 * check for every decision their map says is verified by a check, on exactly the frames it names, and
 * draw from the committed fixture.
 *
 * They also name the operators and reasons the app names. The panel's builder and its checks each
 * hold the operator words as Dan settled them (round 4, 2026-10-21) and the fixture holds the reasons,
 * so all three are compared with the shared lists the app reads (CONDITION_OPERATOR_SPECS,
 * LEAD_REJECTION_REASONS): a label changed in one place and not the other fails here rather than in
 * a design score nobody has run yet.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONDITION_OPERATORS,
  CONDITION_OPERATOR_SPECS,
  LEAD_REJECTION_REASONS,
  isConditionOperator,
} from '@bidspoke/workflow-definition'
import { coverageProblems, designPath, readSettledDesign } from './_settled-design'

const DESIGNS = ['lead-validation-node', 'lead-validation-node-card']
const read = (rel: string) => readFileSync(designPath(rel), 'utf8')
const SETTLED_WORDS = CONDITION_OPERATORS.map((op) => CONDITION_OPERATOR_SPECS[op].label)

interface Fixture {
  reasons: string[]
  missing: { value: string; label: string }[]
  checks: { label: string; reason: string; rows: { field: string; operator: string; value: string }[] }[]
}

/** The JSON array assigned to `var <name> =` in a design script, which holds only string literals. */
function arrayIn(source: string, name: string): unknown {
  const m = new RegExp(`var ${name} = (\\[[\\s\\S]*?\\]);`).exec(source)
  if (!m) throw new Error(`no var ${name} in the script`)
  return JSON.parse(m[1])
}

describe('settled lead validation designs (#2590, #2588)', () => {
  for (const name of DESIGNS) {
    const { decisions, frameIds, checks } = readSettledDesign(name)

    it(`${name}: every checked decision has its check, on every frame it shows on`, () => {
      expect(checks.length).toBeGreaterThan(0)
      expect(coverageProblems(decisions, checks, frameIds)).toEqual([])
    })

    it(`${name}: every decision has exactly one owner, #2590 or #2588`, () => {
      expect(decisions.filter((d) => !d.requirement === !d.noCode).map((d) => d.id)).toEqual([])
      expect(decisions.filter((d) => d.requirement && !['2590', '2588'].includes(d.requirement)).map((d) => d.id)).toEqual([])
    })

    it(`${name}: its regeneration spec draws from the committed fixture`, () => {
      const spec = JSON.parse(read(`${name}/settled.json`)) as { fixture: string; frames: { id: string }[] }
      expect(path.resolve(designPath(name), spec.fixture)).toBe(designPath('lead-validation-node.fixture.json'))
      expect(spec.frames.map((f) => f.id)).toEqual(frameIds)
    })
  }

  const fixture = JSON.parse(read('lead-validation-node.fixture.json')) as Fixture

  it('the fixture offers exactly the shared rejection reasons, and every check uses a listed reason and operator', () => {
    expect(fixture.reasons).toEqual([...LEAD_REJECTION_REASONS])
    for (const c of fixture.checks) {
      expect(fixture.reasons).toContain(c.reason)
      for (const r of c.rows) expect(isConditionOperator(r.operator)).toBe(true)
    }
    expect(fixture.missing.map((m) => m.label)).toEqual(['Reject with this reason', 'Let it through', 'Fail the run'])
  })

  it('the panel builder draws the operator dropdown in the shared list\'s order and words', () => {
    const labels = arrayIn(read('lead-validation-node/builder.js'), 'LABELS') as [string, string][]
    expect(labels.map(([op]) => op)).toEqual([...CONDITION_OPERATORS])
    expect(labels.map(([, label]) => label)).toEqual(SETTLED_WORDS)
  })

  it('the panel checks expect the shared list\'s words, ending with the two Dan settled', () => {
    const words = arrayIn(read('lead-validation-node.checks.js'), 'OPERATORS') as string[]
    expect(words).toEqual(SETTLED_WORDS)
    expect(words.slice(-2)).toEqual(['contains a letter', 'is not empty'])
  })
})
