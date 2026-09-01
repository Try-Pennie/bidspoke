import type { StepOutput, WorkflowDefinition } from '../types'
import { parseStepPath } from '@bidspoke/references'
import { resolveStepField } from './context'
import { deriveWatchedFields } from './watched-fields'

export { deriveWatchedFields }

/**
 * Parse a watched-field path into namespace-rooted segments, through the shared
 * reference parser (#433) so this and the derivation that produced the path
 * cannot disagree about what the path names.
 */
const parseWatchedField = parseStepPath

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
 * Whether to emit the per-execution capture heartbeat log for this execution
 * (#434). The dark capture writes the field_presence column on every run, but
 * logging on every run is ~500K lines/month for a dark feature. Sample ~1%
 * deterministically off the execution id (FNV-ish string hash mod 100) so a
 * heartbeat still proves the write path is alive at ~1% of the volume. The DB
 * write itself is unaffected.
 */
export function shouldLogCapture(executionId: string): boolean {
  let h = 0
  for (let i = 0; i < executionId.length; i++) {
    h = (h * 31 + executionId.charCodeAt(i)) | 0
  }
  return Math.abs(h) % 100 === 0
}

/**
 * Finalize-time glue: derives the watched-field map for this definition and
 * computes presence from the in-memory step outputs. Returns undefined when the
 * flag is off so callers can omit the column entirely.
 */
export function fieldPresenceForCapture(
  flag: string | undefined,
  steps: Record<string, StepOutput>,
  definition: WorkflowDefinition,
): Record<string, boolean> | undefined {
  if (flag !== 'true') return undefined
  return computeFieldPresence(steps, deriveWatchedFields(definition))
}
