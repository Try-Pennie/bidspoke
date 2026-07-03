import type { IdempotencyState } from '../types'

// Source is part of the key so two different sources hitting the same
// workflow (the default, unrestricted posture — see enforceSourceAssignment)
// can never collide on a caller-supplied or payload-derived idempotency key
// and replay each other's cached response (#490).
const key = (workflowId: string, source: string, idempotencyKey: string) =>
  `idempotent-${workflowId}-${source}-${idempotencyKey}`

// Returns cached response if found, null otherwise
export async function checkIdempotency(
  kv: KVNamespace,
  workflowId: string,
  source: string,
  idempotencyKey: string
): Promise<IdempotencyState | null> {
  const cached = await kv.get(key(workflowId, source, idempotencyKey), 'json')
  return cached as IdempotencyState | null
}

// Write placeholder while execution is in-flight — causes concurrent duplicate to get 409
export async function setIdempotencyProcessing(
  kv: KVNamespace,
  workflowId: string,
  source: string,
  idempotencyKey: string,
  ttlSeconds: number
): Promise<void> {
  const state: IdempotencyState = { status: 'processing' }
  await kv.put(key(workflowId, source, idempotencyKey), JSON.stringify(state), {
    expirationTtl: ttlSeconds,
  })
}

// Overwrite placeholder with the actual response once execution completes.
// Status + headers are stored so a replay reproduces the original wire
// contract (a 4xx business rejection must not replay as a bare 200).
export async function setIdempotencyResult(
  kv: KVNamespace,
  workflowId: string,
  source: string,
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
  await kv.put(key(workflowId, source, idempotencyKey), JSON.stringify(state), {
    expirationTtl: ttlSeconds,
  })
}

// Remove the entry after a failed execution. A failure must not be replayed
// as the cached answer — clearing the key lets the source's retry re-execute
// instead of receiving the stale error for the rest of the TTL.
export async function clearIdempotency(
  kv: KVNamespace,
  workflowId: string,
  source: string,
  idempotencyKey: string
): Promise<void> {
  await kv.delete(key(workflowId, source, idempotencyKey))
}
