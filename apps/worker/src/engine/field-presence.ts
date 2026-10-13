import type { StepOutput, WorkflowDefinition } from '../types'
import { parseStepPath } from '@bidspoke/references'
import { stepFieldPresence } from './context'
import { deriveWatchedFieldMap, deriveWatchedFields } from './watched-fields'

export { deriveWatchedFields }

/** One run's field presence: `true` a value, `null` empty, `false` a wrong path. */
export type FieldPresenceMap = Record<string, boolean | null>

/**
 * Which meaning a run's map was written in (#2018). Version 1 (no stamp) folded
 * an empty value and a missing key into one `false`; version 2 tells them apart.
 * The rollup counts the runs written at 2, so the dead tier only reads key
 * presence where every run of a day can carry it, never across the deploy that
 * changed the meaning or a rollback of it.
 */
export const FIELD_PRESENCE_VERSION = 2

/**
 * The columns a run's row carries for field presence: the map and its version,
 * always together, or neither when capture is off. The one place both engine
 * finalize writes take them from, so the stamp cannot be left off either.
 */
export function fieldPresenceColumns(
  map: FieldPresenceMap | undefined,
): { field_presence?: FieldPresenceMap; field_presence_version?: number } {
  return map ? { field_presence: map, field_presence_version: FIELD_PRESENCE_VERSION } : {}
}

/**
 * Parse a watched-field path into namespace-rooted segments, through the shared
 * reference parser (#433) so this and the derivation that produced the path
 * cannot disagree about what the path names.
 */
const parseWatchedField = parseStepPath

/**
 * Per-execution field-presence map: for each watched field whose producing node
 * ran this execution, whether the field carried a value. Fields whose node did
 * not run are OMITTED, so a present key means the node ran (the ran_count
 * denominator). The value is `true` for a value (the present_count), `null` for
 * empty, and `false` when the path names a key some object along it lacks, the
 * wrong path signature (#2018, see `stepFieldPresence`). Every SQL reader counts
 * only `true` as present, so `null` changes no existing count. No resolved value
 * is ever stored, so no PII can leak into the persisted map.
 *
 * `gates` maps a field to the ending steps it is judged behind (WatchedField
 * `gate`). Such a field is also OMITTED on a run where none of them ran,
 * because nothing read it on that run. Without this a refusal reason that only
 * the refusal response reads counted as empty on every run its producer ran,
 * and paged as never resolving in a week with no refusals (#1215). A field
 * missing from the map, or mapped to null or an empty list, is judged the old
 * way, which can only page, never hide.
 */
export function computeFieldPresence(
  steps: Record<string, StepOutput>,
  watchedFields: string[],
  gates?: ReadonlyMap<string, readonly string[] | null>,
): FieldPresenceMap {
  const presence: FieldPresenceMap = {}
  for (const field of watchedFields) {
    const segments = parseWatchedField(field)
    const ns = segments[0]
    if (!ns || !(ns in steps)) continue
    const key = segments.join('.')
    const gate = gates?.get(key)
    if (gate && gate.length > 0 && !gate.some((ending) => ending in steps)) continue
    presence[key] = stepFieldPresence(steps, segments)
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
): FieldPresenceMap | undefined {
  if (flag !== 'true') return undefined
  const { fields } = deriveWatchedFieldMap(definition)
  return computeFieldPresence(
    steps,
    fields.map((f) => f.path),
    new Map(fields.map((f) => [f.path, f.gate])),
  )
}
