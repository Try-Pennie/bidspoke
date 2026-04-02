// Derive an idempotency key by hashing selected fields from the payload
export async function deriveIdempotencyKey(
  payload: unknown,
  fields: string[]
): Promise<string> {
  const values = fields.map((path) => getNestedValue(payload, path) ?? '')
  const input = values.join('|')
  const encoded = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function generateTraceId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function getNestedValue(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, key) => {
    if (cur !== null && typeof cur === 'object') {
      return (cur as Record<string, unknown>)[key]
    }
    return undefined
  }, obj)
}
