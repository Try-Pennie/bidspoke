/**
 * The definition_schema_version a definition write stores (#1947): which rules
 * the stored definition is judged by, read back through readSchemaStamp in
 * @bidspoke/workflow-definition. These two are the only sources of the value;
 * a writer never takes it from the caller, so a request cannot label its own
 * definition as checked under rules it chose.
 *
 * - A definition this request wrote (a create, a save that sends one) is
 *   stamped with the version this build checks by.
 * - A definition copied from a stored row (a restore, a duplicate, the
 *   snapshot a save without a definition takes of the stored one) keeps that
 *   row's stamp, unstamped included. A copy was checked when it was first
 *   written, under the rules of its own stamp, so labelling it newer would
 *   claim a check it never had, and an unstamped row stays unstamped rather
 *   than being read as version 1 forever by a stamp of 1.
 *
 * Order (L255, L640): every reader learns a version one release before any
 * writer stamps it. Only version 1 exists, and readers have handled it since
 * #2649, so stamping it is safe today. A version 2 is added to the package's
 * DEFINITION_SCHEMA_VERSIONS in one release and becomes this build's stamp
 * only in a later one.
 */
import { DEFINITION_SCHEMA_VERSION } from '@bidspoke/workflow-definition'

/** The stamp of a definition this request wrote. */
export function writtenDefinitionStamp(): number {
  return DEFINITION_SCHEMA_VERSION
}

/** The stamp of a definition copied from a stored row: the row's own, unstamped included. */
export function copiedDefinitionStamp(row: { definition_schema_version?: number | null }): number | null {
  return row.definition_schema_version ?? null
}
