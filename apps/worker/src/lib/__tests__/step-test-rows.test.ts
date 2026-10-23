/**
 * The data picker's rows from a step's kept test answer (#2339): each row a
 * label, the reference a later step writes, and a sample of the value. Every
 * path is resolved here through the engine's own resolver, so a row can never
 * name a reference the run would read differently (L370).
 */
import { describe, expect, it } from 'vitest'
import { buildContext, resolveValue } from '../../engine/context'
import { PICKER_MAX_ROWS, PICKER_SAMPLE_MAX, stepTestRows } from '../step-test-rows'

const answer = {
  id: 42,
  ok: true,
  note: null,
  files: [{ name: 'a.csv', size: 10 }, { name: 'b.csv', size: 20 }],
  'Content-Type': 'text/csv',
  owner: { email: 'ops@trypennie.com' },
}

function resolve(path: string, output: unknown): unknown {
  const ctx = buildContext({}, 'step_test', 'wf', 'exec', {}, 'org', 'exec')
  ctx.steps.find_files = { output, status: 'completed' }
  return resolveValue(`{{${path}}}`, ctx)
}

describe('the data picker rows of a kept test answer', () => {
  it('names every field the answer holds, a list by its first item, each with a sample', () => {
    const { rows, truncated } = stepTestRows('find_files', answer)
    expect(truncated).toBe(false)
    expect(rows).toEqual([
      { label: 'Whole answer', path: 'steps.find_files.output', sample: '6 fields' },
      { label: 'id', path: 'steps.find_files.output.id', sample: '42' },
      { label: 'ok', path: 'steps.find_files.output.ok', sample: 'true' },
      { label: 'note', path: 'steps.find_files.output.note', sample: 'null' },
      { label: 'files', path: 'steps.find_files.output.files', sample: '2 items' },
      { label: 'files, first item', path: 'steps.find_files.output.files[0]', sample: '2 fields' },
      { label: 'files, first item, name', path: 'steps.find_files.output.files[0].name', sample: 'a.csv' },
      { label: 'files, first item, size', path: 'steps.find_files.output.files[0].size', sample: '10' },
      { label: 'Content-Type', path: "steps.find_files.output['Content-Type']", sample: 'text/csv' },
      { label: 'owner', path: 'steps.find_files.output.owner', sample: '1 field' },
      { label: 'owner, email', path: 'steps.find_files.output.owner.email', sample: 'ops@trypennie.com' },
    ])
  })

  it('every path resolves, through the engine, to the value its sample shows', () => {
    for (const row of stepTestRows('find_files', answer).rows) {
      const value = resolve(row.path, answer)
      expect(value, row.path).not.toBeUndefined()
      if (value === null || typeof value !== 'object') expect(String(value), row.path).toBe(row.sample)
    }
  })

  it('leaves out a key no reference can name, rather than offering one that reads nothing', () => {
    const { rows } = stepTestRows('s', { "it's": 1, 'a]b': 2, 'x{y': 3, fine: 4 })
    expect(rows.map((r) => r.label)).toEqual(['Whole answer', 'fine'])
  })

  it(`clips a long sample to ${PICKER_SAMPLE_MAX} characters`, () => {
    const { rows } = stepTestRows('s', { long: 'x'.repeat(1000) })
    expect(rows[1].sample.length).toBeLessThanOrEqual(PICKER_SAMPLE_MAX + 1)
  })

  it(`stops at ${PICKER_MAX_ROWS} rows and says so`, () => {
    const wide = Object.fromEntries(Array.from({ length: PICKER_MAX_ROWS + 50 }, (_, i) => [`f${i}`, i]))
    const { rows, truncated } = stepTestRows('s', wide)
    expect(rows).toHaveLength(PICKER_MAX_ROWS)
    expect(truncated).toBe(true)
  })

  it('a plain answer is one row, and an empty list says it is empty', () => {
    expect(stepTestRows('s', 'done').rows).toEqual([{ label: 'Whole answer', path: 'steps.s.output', sample: 'done' }])
    expect(stepTestRows('s', { items: [] }).rows[1]).toEqual({ label: 'items', path: 'steps.s.output.items', sample: 'No items' })
  })
})
