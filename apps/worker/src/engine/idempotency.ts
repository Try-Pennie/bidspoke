import type { IdempotencyState } from '../types'

const key = (workflowId: string, idempotencyKey: string) =>
  `idempotent-${workflowId}-${idempotencyKey}`

// Returns cached response if found, null otherwise
export async function checkIdempotency(
  kv: KVNamespace,
  workflowId: string,
  idempotencyKey: string
): Promise<IdempotencyState | null> {
  const cached = await kv.get(key(workflowId, idempotencyKey), 'json')
  return cached as IdempotencyState | null
}

// Write placeholder while execution is in-flight — causes concurrent duplicate to get 409
export async function setIdempotencyProcessing(
  kv: KVNamespace,
  workflowId: string,
  idempotencyKey: string,
  ttlSeconds: number
): Promise<void> {
  const state: IdempotencyState = { status: 'processing' }
  await kv.put(key(workflowId, idempotencyKey), JSON.stringify(state), {
    expirationTtl: ttlSeconds,
  })
}

// Overwrite placeholder with the actual response once execution completes
export async function setIdempotencyResult(
  kv: KVNamespace,
  workflowId: string,
  idempotencyKey: string,
  response: unknown,
  ttlSeconds: number
): Promise<void> {
  const state: IdempotencyState = { status: 'complete', response }
  await kv.put(key(workflowId, idempotencyKey), JSON.stringify(state), {
    expirationTtl: ttlSeconds,
  })
}
