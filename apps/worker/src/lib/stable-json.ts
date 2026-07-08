/**
 * Structural, key-order-independent JSON comparison (#569).
 *
 * The workflow definition is stored as Postgres `jsonb`, which does NOT preserve
 * object key insertion order. So a definition round-tripped through the DB can
 * never be compared to an incoming request body with a plain `JSON.stringify`
 * equality check: the same content serializes to different strings. These
 * helpers canonicalize by sorting object keys recursively (array order is left
 * intact, since node/edge ordering is meaningful) so equal content compares
 * equal regardless of key order.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      out[key] = canonicalize(obj[key])
    }
    return out
  }
  return value
}
