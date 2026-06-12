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

// Overwrite placeholder with the actual response once execution completes.
// Status + headers are stored so a replay reproduces the original wire
// contract (a 4xx business rejection must not replay as a bare 200).
export async function setIdempotencyResult(
  kv: KVNamespace,
  workflowId: string,
  idempotencyKey: string,
  response: unknown,
  ttlSeconds: number,
  responseStatus?: number,
  responseHeaders?: Record<string, string>
): Promise<void> {
  const state: IdempotencyState = {
    status: 'complete',
    response,
    responseStatus,
    responseHeaders,
  }
  await kv.put(key(workflowId, idempotencyKey), JSON.stringify(state), {
    expirationTtl: ttlSeconds,
  })
}

// Remove the entry after a failed execution. A failure must not be replayed
// as the cached answer — clearing the key lets the source's retry re-execute
// instead of receiving the stale error for the rest of the TTL.
export async function clearIdempotency(
  kv: KVNamespace,
  workflowId: string,
  idempotencyKey: string
): Promise<void> {
  await kv.delete(key(workflowId, idempotencyKey))
}
