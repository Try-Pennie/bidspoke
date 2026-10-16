/** Types for redact.mjs, so the TypeScript that checks the fixtures can import it. */
export interface Redactor {
  partner<T extends Record<string, unknown>>(row: T): T
  profile<T>(doc: T): T
}
export function createRedactor(): Redactor
export function stringsIn(value: unknown): string[]
