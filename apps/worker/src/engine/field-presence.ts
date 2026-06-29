import type { StepOutput, WorkflowDefinition } from '../types'
import { resolveStepField } from './context'

/**
 * Parse a watched-field path into namespace-rooted segments. Strips an optional
 * leading `steps.` and collapses an explicit `.output` wrapper after the
 * namespace, so `steps.x.output.y`, `steps.x.y`, and `x.y` all normalize to
 * ['x', 'y'].
 */
function parseWatchedField(field: string): string[] {
  let segs = field.split('.').filter(Boolean)
  if (segs[0] === 'steps') segs = segs.slice(1)
  if (segs[1] === 'output') segs = [segs[0], ...segs.slice(2)]
  return segs
}

/**
 * Per-execution field-presence map: for each watched field whose producing node
 * ran this execution, a boolean for whether the field carried a value (non-null).
 * Fields whose node did not run are OMITTED, so a present key means the node ran
 * (the ran_count denominator) and its value means the field was non-null (the
 * present_count). Booleans only — no resolved value is ever stored, so no PII can
 * leak into the persisted map.
 */
export function computeFieldPresence(
  steps: Record<string, StepOutput>,
  watchedFields: string[],
): Record<string, boolean> {
  const presence: Record<string, boolean> = {}
  for (const field of watchedFields) {
    const segments = parseWatchedField(field)
    const ns = segments[0]
    if (!ns || !(ns in steps)) continue
    const value = resolveStepField(steps, segments)
    presence[segments.join('.')] = value !== null && value !== undefined
  }
  return presence
}

/**
 * The set of field paths to watch for this workflow definition. Phase 0 stub:
 * returns []. Phase 1 (#420) derives this from structured references (templates,
 * filter/branch/edge conditions, transform mappings) plus a deep scan of
 * code-node scripts. Kept as the single seam so Phase 1 swaps the body without
 * touching the finalize write path.
 */
export function deriveWatchedFields(_definition: WorkflowDefinition): string[] {
  return []
}
