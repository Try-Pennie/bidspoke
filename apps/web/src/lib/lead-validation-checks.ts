/**
 * The edits the lead validation settings list makes to a step's ordered checks
 * (#2590), and which check stays chosen after each. Pure, so the order a lead
 * is judged in, which these edits decide, is tested without a panel.
 *
 * Checks are read from stored config and written back whole, so they are
 * handled as records: whatever a check holds that the panel does not draw is
 * carried through an edit untouched.
 */

type Check = Record<string, unknown>

export interface ChecksEdit<T extends Check = Check> {
  checks: T[]
  /** The index of the check the editor holds after the edit. */
  chosen: number
}

/** The smallest `check_N` the step does not hold yet: ids only need to be unique within the step. */
export function nextCheckId(checks: ReadonlyArray<{ id?: unknown }>): string {
  const used = new Set(checks.map((c) => c.id))
  let n = 1
  while (used.has(`check_${n}`)) n++
  return `check_${n}`
}

/**
 * A check to fill in: one empty condition, no reason chosen (the save check
 * refuses one on a live workflow, so a reason is never defaulted), and a lead
 * missing a value rejected, as the validate scripts did.
 */
export function blankCheck(id: string) {
  return {
    id,
    label: '',
    condition: { logic: 'AND' as const, groups: [{ logic: 'AND' as const, conditions: [{ field: '', operator: 'eq' as const, value: '' }] }] },
    reason: '',
    on_missing: 'reject' as const,
  }
}

/** The config of a lead validation step dropped on the canvas: one blank check open to fill in. */
export function newLeadValidationConfig() {
  return { lead_id_field: '', checks: [blankCheck(nextCheckId([]))] }
}

/** A remembered choice kept inside the list, which the config can shrink underneath. */
export function chosenIndex(chosen: number, count: number): number {
  if (count <= 0) return 0
  return Math.min(Math.max(chosen, 0), count - 1)
}

export function addCheck<T extends Check>(checks: T[]): ChecksEdit<T | ReturnType<typeof blankCheck>> {
  return { checks: [...checks, blankCheck(nextCheckId(checks))], chosen: checks.length }
}

/** Moves the chosen check one place up (-1) or down (1); it stays chosen. A move past either end changes nothing. */
export function moveCheck<T extends Check>(checks: T[], chosen: number, dir: -1 | 1): ChecksEdit<T> {
  const to = chosen + dir
  if (chosen < 0 || chosen >= checks.length || to < 0 || to >= checks.length) return { checks, chosen: chosenIndex(chosen, checks.length) }
  const next = [...checks]
  ;[next[chosen], next[to]] = [next[to], next[chosen]]
  return { checks: next, chosen: to }
}

/** Removes the chosen check; the one that takes its place is chosen, or the new last one. */
export function removeCheck<T extends Check>(checks: T[], chosen: number): ChecksEdit<T> {
  const next = checks.filter((_, i) => i !== chosen)
  return { checks: next, chosen: chosenIndex(chosen, next.length) }
}
