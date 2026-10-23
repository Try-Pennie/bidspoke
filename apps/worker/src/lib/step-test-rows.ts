/**
 * The data picker's rows from a step's kept test answer (#2339, phase 9 of
 * #1689): each row a label, the reference a later step writes to read that
 * value (steps.<step id>.output...), and a short sample of it.
 *
 * Paths are written in the engine's own reference syntax (engine/context.ts:
 * dot segments, a list item as [0], any other key as ['key']), and the test
 * resolves every one through the engine's resolver, so a row never offers a
 * reference a run would read differently. A key that syntax cannot name (one
 * holding a quote, a bracket or a brace) is left out rather than offered.
 *
 * A list is shown by its first item, as a picker shows a sample: the reference
 * names that item, and a person edits the index if they want another.
 */

export interface PickerRow {
  label: string
  path: string
  sample: string
}

export const PICKER_MAX_ROWS = 300
export const PICKER_SAMPLE_MAX = 120
const MAX_DEPTH = 8

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const UNNAMEABLE = /['"[\]{}]/

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function sampleOf(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? 'No items' : count(value.length, 'item', 'items')
  if (value !== null && typeof value === 'object') return count(Object.keys(value).length, 'field', 'fields')
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return text.length <= PICKER_SAMPLE_MAX ? text : `${text.slice(0, PICKER_SAMPLE_MAX)}…`
}

function keySegment(key: string): string | null {
  if (IDENTIFIER.test(key)) return `.${key}`
  if (key === '' || UNNAMEABLE.test(key)) return null
  return `['${key}']`
}

/** The rows of one step's answer, in the order its fields appear; truncated says some were left out for the cap. */
export function stepTestRows(namespace: string, output: unknown): { rows: PickerRow[]; truncated: boolean } {
  const rows: PickerRow[] = []
  let truncated = false

  const visit = (value: unknown, path: string, label: string, depth: number) => {
    if (rows.length >= PICKER_MAX_ROWS) {
      truncated = true
      return
    }
    rows.push({ label, path, sample: sampleOf(value) })
    if (depth >= MAX_DEPTH) return
    const prefix = depth === 0 ? '' : `${label}, `
    if (Array.isArray(value)) {
      if (value.length > 0) visit(value[0], `${path}[0]`, `${prefix}first item`, depth + 1)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        const segment = keySegment(key)
        if (segment !== null) visit(child, `${path}${segment}`, `${prefix}${key}`, depth + 1)
      }
    }
  }

  visit(output, `steps.${namespace}.output`, 'Whole answer', 0)
  return { rows, truncated }
}
