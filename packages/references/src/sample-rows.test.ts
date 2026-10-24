import { describe, expect, it } from 'vitest'
import { SAMPLE_ITEMS_MAX, SAMPLE_MAX_ROWS, SAMPLE_TEXT_MAX, sampleLabel, sampleRows } from './sample-rows'

/**
 * The data picker's rows (#2338, #2339; plan 3.3 of #1689): whole arrays and
 * each item, each a label, a reference and a sample. That every path resolves
 * through the engine is proven in the worker (lib/__tests__/sample-rows-resolve.test.ts).
 */
describe('sampleRows', () => {
  it('names each field as a person reads it, with its sample, under the root it is read from', () => {
    expect(sampleRows('trigger.payload', { email: 'maria.lopez@example.com', first_name: 'Maria', enrolled_debt: 18450, active: true, note: null }).rows).toEqual([
      { label: 'Email', path: 'trigger.payload.email', sample: 'maria.lopez@example.com' },
      { label: 'First name', path: 'trigger.payload.first_name', sample: 'Maria' },
      { label: 'Enrolled debt', path: 'trigger.payload.enrolled_debt', sample: '18450' },
      { label: 'Active', path: 'trigger.payload.active', sample: 'true' },
      { label: 'Note', path: 'trigger.payload.note', sample: 'null' },
    ])
  })

  it('gives a list a row of its own and each item one, and names nested fields after their parent', () => {
    expect(sampleRows('steps.find.output', { files: [{ name: 'a.csv' }, { name: 'b.csv' }], owner: { email: 'ops@trypennie.com' } }).rows).toEqual([
      { label: 'Files', path: 'steps.find.output.files', sample: '2 items' },
      { label: 'Files item 1', path: 'steps.find.output.files[0]', sample: '1 field' },
      { label: 'Files item 1 name', path: 'steps.find.output.files[0].name', sample: 'a.csv' },
      { label: 'Files item 2', path: 'steps.find.output.files[1]', sample: '1 field' },
      { label: 'Files item 2 name', path: 'steps.find.output.files[1].name', sample: 'b.csv' },
      { label: 'Owner', path: 'steps.find.output.owner', sample: '1 field' },
      { label: 'Owner email', path: 'steps.find.output.owner.email', sample: 'ops@trypennie.com' },
    ])
  })

  it('a list at the root is its items, and a plain value is one row', () => {
    expect(sampleRows('steps.s.output', ['x']).rows).toEqual([{ label: 'Item 1', path: 'steps.s.output[0]', sample: 'x' }])
    expect(sampleRows('steps.s.output', 'done').rows).toEqual([{ label: 'Value', path: 'steps.s.output', sample: 'done' }])
    expect(sampleRows('steps.s.output', { items: [] }).rows).toEqual([{ label: 'Items', path: 'steps.s.output.items', sample: 'No items' }])
  })

  it('writes a key no identifier can spell in brackets, and leaves out one no reference can name', () => {
    expect(sampleRows('trigger.payload', { 'Content-Type': 'text/csv', "it's": 1, 'a]b': 2, 'x{y': 3 }).rows).toEqual([
      { label: 'Content type', path: "trigger.payload['Content-Type']", sample: 'text/csv' },
    ])
  })

  it(`keeps ${SAMPLE_ITEMS_MAX} items of a list and ${SAMPLE_MAX_ROWS} rows in all, saying so, and clips a sample to ${SAMPLE_TEXT_MAX} characters`, () => {
    const long = sampleRows('t', { list: Array.from({ length: SAMPLE_ITEMS_MAX + 5 }, (_, i) => i) })
    expect(long.rows).toHaveLength(SAMPLE_ITEMS_MAX + 1)
    expect(long.truncated).toBe(true)
    const wide = sampleRows('t', Object.fromEntries(Array.from({ length: SAMPLE_MAX_ROWS + 50 }, (_, i) => [`f${i}`, i])))
    expect(wide.rows).toHaveLength(SAMPLE_MAX_ROWS)
    expect(wide.truncated).toBe(true)
    expect(sampleRows('t', { s: 'x'.repeat(1000) }).rows[0].sample.length).toBe(SAMPLE_TEXT_MAX + 1)
  })

  it('reads first_name, first-name and firstName alike', () => {
    expect(['first_name', 'first-name', 'firstName'].map(sampleLabel)).toEqual(['First name', 'First name', 'First name'])
  })
})
