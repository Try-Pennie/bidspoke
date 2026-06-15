// Shared logic for the canvas key/value editors (Constants, Integration headers,
// Response headers, injected fields) — issue #96.
//
// Those editors stored rows as a name-keyed object and rebuilt it on every
// keystroke, keyed React rows by the map key. Two consequences: typing in a key
// field remounted the row (focus lost every character), and renaming a key by
// rebuilding `obj[newKey] = v` merged two entries the instant a name collided
// (including transient states while typing), destroying one value with no
// warning.
//
// The editors now hold an ordered list of rows with stable ids, so a row keeps
// its identity (and focus) while editing and two rows can briefly share a name
// without merging. Rows serialize back to the object only when valid; an empty
// or duplicate key marks the row invalid (red) and blocks save.

export interface KVRow<V = string> {
  id: string
  key: string
  value: V
}

/** Stable-id rows from a persisted object (insertion order preserved). */
export function objectToRows<V>(obj: Record<string, V>): KVRow<V>[] {
  return Object.entries(obj).map(([key, value], i) => ({ id: `r${i}`, key, value }))
}

/** Serialize rows back to an object. Skips blank keys; last write wins on a dup
 *  (only ever called on a valid row set, where neither happens). */
export function rowsToObject<V>(rows: KVRow<V>[]): Record<string, V> {
  const out: Record<string, V> = {}
  for (const r of rows) {
    if (r.key.trim() !== '') out[r.key] = r.value
  }
  return out
}

/** Ids of rows with an invalid key: blank, or a (trimmed) name shared by another
 *  row. These turn red and block save. */
export function invalidRowIds<V>(rows: KVRow<V>[]): Set<string> {
  const counts = new Map<string, number>()
  for (const r of rows) {
    const k = r.key.trim()
    if (k !== '') counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const invalid = new Set<string>()
  for (const r of rows) {
    const k = r.key.trim()
    if (k === '' || (counts.get(k) ?? 0) > 1) invalid.add(r.id)
  }
  return invalid
}

export function rowsValid<V>(rows: KVRow<V>[]): boolean {
  return invalidRowIds(rows).size === 0
}
