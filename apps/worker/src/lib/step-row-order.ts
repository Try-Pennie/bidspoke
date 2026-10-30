/**
 * The order a run's step rows are listed in (#3084).
 *
 * The run page, the test panel and every other screen showing a run's steps
 * list them in the order the executions API returns them, and the API orders
 * them here, the same way for a run read from Postgres, a run read from the
 * archive (whose bundle holds its steps in the order the archiver paged them,
 * by id, so not by step at all) and a resume merged with the steps it inherits.
 *
 * By `step_order` first. Since #3084 every row of a run has its own order, so
 * that decides alone. Rows written before #3084 can share one: a parallel
 * slot's later steps took the next slot's orders and the last slot's took
 * parallel_end's (20,178 Main Flow runs in the week to 2026-10-30). Those ties
 * are broken so the list is the same on every read: parallel_end after the
 * step it shares an order with, since it closes the block; then the step that
 * started first; then the row id, which only makes the order stable.
 *
 * A row with no order (the column is nullable; the engine always writes one)
 * goes last, keeping its place among the others with none.
 */
export interface OrderedStepRow {
  step_order?: unknown
  step_type?: unknown
  started_at?: unknown
  id?: unknown
}

function orderOf(row: OrderedStepRow): number | null {
  const v = row.step_order
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')

export function compareStepRows(a: OrderedStepRow, b: OrderedStepRow): number {
  const ao = orderOf(a)
  const bo = orderOf(b)
  if (ao === null || bo === null) return ao === null ? (bo === null ? 0 : 1) : -1
  if (ao !== bo) return ao - bo
  const aEnd = a.step_type === 'parallel_end' ? 1 : 0
  const bEnd = b.step_type === 'parallel_end' ? 1 : 0
  if (aEnd !== bEnd) return aEnd - bEnd
  const aStart = Date.parse(text(a.started_at))
  const bStart = Date.parse(text(b.started_at))
  if (Number.isFinite(aStart) && Number.isFinite(bStart) && aStart !== bStart) return aStart - bStart
  const aId = text(a.id)
  const bId = text(b.id)
  return aId < bId ? -1 : aId > bId ? 1 : 0
}

/** A copy of `rows` in the order a run's steps are listed. */
export function sortStepRows<T extends OrderedStepRow>(rows: readonly T[]): T[] {
  return [...rows].sort(compareStepRows)
}
