/**
 * definition_schema_version (#1947): which set of rules a stored definition is
 * judged by.
 *
 * Every version listed here is frozen once a definition has been stored under
 * it (L1010): a change to what a definition may hold adds a new version, with
 * the rules that take effect at it, and never edits an old one, so a row keeps
 * meaning what it meant when it was written.
 *
 * The stamp is the definition_schema_version column of workflows and
 * workflow_versions, written only through the write_workflow database
 * function (#1947): a definition a request writes gets this build's version,
 * which the Worker sends (apps/worker/src/lib/definition-stamp.ts), and a
 * copied one keeps the stamp of the row it came from, which the function
 * reads itself and refuses from a caller. A row
 * written before the column existed is unstamped, and an unstamped one is
 * version 1, the rules as they stood before any stamp.
 *
 * A reader older than the writer will meet a stamp it does not know during
 * every deploy, when both run at once (L640). That reading is a named result,
 * `unknown_schema_version`, which every caller must handle; it is never an
 * empty list of problems, because an empty list reads as a clean definition
 * (L255). The version is bumped reader before writer: every reader learns the
 * new stamp in one release, and only a later release lets a writer stamp it.
 */

/** Every version this code knows, oldest first, with no gap. */
export const DEFINITION_SCHEMA_VERSIONS = [1] as const
export type DefinitionSchemaVersion = (typeof DEFINITION_SCHEMA_VERSIONS)[number]

/** The version a definition saved now is stamped with. */
export const DEFINITION_SCHEMA_VERSION: DefinitionSchemaVersion = DEFINITION_SCHEMA_VERSIONS[DEFINITION_SCHEMA_VERSIONS.length - 1]

/** What an unstamped definition is: every row written before the stamp existed. */
export const OLDEST_DEFINITION_SCHEMA_VERSION: DefinitionSchemaVersion = DEFINITION_SCHEMA_VERSIONS[0]

/**
 * What a stored stamp says. `known` is the newest version the reader has rules
 * for; it defaults to this code's, and a test of the version gating passes a
 * larger one with its own rules.
 */
export type SchemaStampReading =
  | { kind: 'stamped'; version: number }
  | { kind: 'unstamped'; version: number }
  | { kind: 'unknown_schema_version'; stamp: number; known: number }
  | { kind: 'invalid_schema_version'; stamp: unknown }

/**
 * Reads a stamp exactly as stored. Only a whole number from 1 is a version; a
 * numeric string, a fraction or zero is refused by name rather than compared,
 * because a value read from storage must never feed a comparison directly (L50).
 */
export function readSchemaStamp(stamp: unknown, known: number = DEFINITION_SCHEMA_VERSION): SchemaStampReading {
  if (stamp === undefined || stamp === null) return { kind: 'unstamped', version: OLDEST_DEFINITION_SCHEMA_VERSION }
  if (typeof stamp !== 'number' || !Number.isInteger(stamp) || stamp < OLDEST_DEFINITION_SCHEMA_VERSION) {
    return { kind: 'invalid_schema_version', stamp }
  }
  if (stamp > known) return { kind: 'unknown_schema_version', stamp, known }
  return { kind: 'stamped', version: stamp }
}
