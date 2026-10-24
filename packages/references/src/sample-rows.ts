/**
 * The data picker's rows from a sample value (#2338, #2339; plan section 3.3 of
 * #1689): each a label, the reference a step writes to read that value, and a
 * short sample of it. "The picker flattens the sample into { label, path,
 * sample } rows (whole arrays and each item)": a list is a row of its own and
 * so is each of its items, up to SAMPLE_ITEMS_MAX of them.
 *
 * One flattening for both apps: the bidding Worker's test result route draws an
 * ops step's kept answer with it, and the canvas draws the trigger's test
 * payload with it, so the two halves of the picker cannot disagree (L370).
 *
 * Paths are in the engine's reference syntax: dot segments, a list item as
 * [0], any other key as ['key']. A key that syntax cannot name (one holding a
 * quote, a bracket or a brace) is left out rather than offered. The worker's
 * test resolves every path through the engine's own resolver.
 */

export interface SampleRow {
  /** The value's name as a person reads it: "First name", "Files item 1 name". */
  label: string
  /** The reference, without braces: trigger.payload.first_name. */
  path: string
  /** The value, or how many items or fields it holds, clipped to SAMPLE_TEXT_MAX. */
  sample: string
}

export const SAMPLE_MAX_ROWS = 300
export const SAMPLE_TEXT_MAX = 120
/** The items of one list given a row each; the list's own row says how many it holds. */
export const SAMPLE_ITEMS_MAX = 20
const MAX_DEPTH = 8

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const UNNAMEABLE = /['"[\]{}]/

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** first_name, first-name and firstName all read "First name". */
export function sampleLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase()
  return words.length === 0 ? key : words[0].toUpperCase() + words.slice(1)
}

function sampleOf(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? 'No items' : count(value.length, 'item', 'items')
  if (value !== null && typeof value === 'object') return count(Object.keys(value).length, 'field', 'fields')
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return text.length <= SAMPLE_TEXT_MAX ? text : `${text.slice(0, SAMPLE_TEXT_MAX)}…`
}

function keySegment(key: string): string | null {
  if (IDENTIFIER.test(key)) return `.${key}`
  if (key === '' || UNNAMEABLE.test(key)) return null
  return `['${key}']`
}

/**
 * The rows of one sample under `root` (trigger.payload, steps.<id>.output), in
 * the order its fields appear. A plain value is one row named Value. truncated
 * says rows were left out for SAMPLE_MAX_ROWS or a list's SAMPLE_ITEMS_MAX.
 */
export function sampleRows(root: string, value: unknown): { rows: SampleRow[]; truncated: boolean } {
  const rows: SampleRow[] = []
  let truncated = false

  const add = (row: SampleRow): boolean => {
    if (rows.length >= SAMPLE_MAX_ROWS) {
      truncated = true
      return false
    }
    rows.push(row)
    return true
  }

  const children = (v: unknown, path: string, label: string, depth: number) => {
    if (depth >= MAX_DEPTH) return
    if (Array.isArray(v)) {
      v.slice(0, SAMPLE_ITEMS_MAX).forEach((item, i) => visit(item, `${path}[${i}]`, label ? `${label} item ${i + 1}` : `Item ${i + 1}`, depth + 1))
      if (v.length > SAMPLE_ITEMS_MAX) truncated = true
      return
    }
    if (v !== null && typeof v === 'object') {
      for (const [key, child] of Object.entries(v)) {
        const segment = keySegment(key)
        if (segment === null) continue
        const name = sampleLabel(key)
        visit(child, `${path}${segment}`, label ? `${label} ${name.toLowerCase()}` : name, depth + 1)
      }
    }
  }

  const visit = (v: unknown, path: string, label: string, depth: number) => {
    if (!add({ label, path, sample: sampleOf(v) })) return
    children(v, path, label, depth)
  }

  if (value !== null && typeof value === 'object') children(value, root, '', 0)
  else add({ label: 'Value', path: root, sample: sampleOf(value) })
  return { rows, truncated }
}
