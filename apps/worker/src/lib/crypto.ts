// Derive an idempotency key by hashing selected fields from the payload.
// Returns null when every configured field is absent/empty: the key would
// otherwise collapse to a constant hash (all fields join to ''), so two
// different malformed leads would share one idempotency entry and could
// receive each other's cached response. A null key means "skip idempotency".
export async function deriveIdempotencyKey(
  payload: unknown,
  fields: string[]
): Promise<string | null> {
  // Preserve the exact historical String() coercion (arrays -> 'a,b', objects ->
  // '[object Object]') so idempotency/dedup hashes never shift on deploy. Array
  // .join applies the same coercion element-by-element, so building the parts
  // explicitly keeps the hashed input byte-for-byte identical to before.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const parts = fields.map((path) => String(getNestedValue(payload, path) ?? ''))
  if (parts.every((p) => p === '')) return null
  const input = parts.join('|')
  const encoded = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export function generateTraceId(): string {
  // 27-char base62 ID. Matches Pipedream's requestId format so engine-side
  // response parsing/validation behaves identically across the two stacks.
  // Format: 4-byte timestamp prefix (seconds since 2014-05-13 KSUID epoch) +
  // 16 random bytes, treated as a 160-bit big-endian integer, mod 62^27, then
  // base62-encoded to fixed 27 chars.
  const ts = Math.floor(Date.now() / 1000) - 1400000000
  const bytes = new Uint8Array(20)
  bytes[0] = (ts >>> 24) & 0xff
  bytes[1] = (ts >>> 16) & 0xff
  bytes[2] = (ts >>> 8) & 0xff
  bytes[3] = ts & 0xff
  crypto.getRandomValues(bytes.subarray(4))

  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  n %= 62n ** 27n

  const out: string[] = new Array(27)
  for (let i = 26; i >= 0; i--) {
    out[i] = BASE62[Number(n % 62n)]
    n /= 62n
  }
  return out.join('')
}

function getNestedValue(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, key) => {
    if (cur !== null && typeof cur === 'object') {
      return (cur as Record<string, unknown>)[key]
    }
    return undefined
  }, obj)
}
