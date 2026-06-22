/**
 * Coerce an arbitrary resolved value to a string for a string-typed context
 * (URLs, header/auth values, SQL export cells, log/Slack fields, hash inputs).
 *
 * Mirrors the historical `String(value ?? '')` coercion these call sites used,
 * with one deliberate improvement: an object/array (which only appears here when
 * a string-typed template field is misconfigured to resolve to a non-string)
 * serializes to JSON instead of the useless '[object Object]'. This also keeps
 * `@typescript-eslint/no-base-to-string` satisfied at the boundary — primitives
 * stringify cleanly and objects are handled explicitly.
 */
export function coerceString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') return JSON.stringify(value) ?? ''
  // number | bigint | boolean | symbol — all stringify cleanly. The rule can't
  // narrow `unknown` this far; this is the one controlled coercion boundary.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(value)
}
