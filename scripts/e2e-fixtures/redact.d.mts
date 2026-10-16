/** Types for redact.mjs, so the TypeScript that checks the fixtures can import it. */
export interface Redactor {
  partner<T extends Record<string, unknown>>(row: T): T
  profile<T>(doc: T): T
  /** A GET /api/partners/:id/history answer (#2141), editors aliased as the partner rows alias them. */
  history<T extends { entries: Array<Record<string, unknown>> }>(answer: T): T
}
export function createRedactor(): Redactor
export function stringsIn(value: unknown): string[]
