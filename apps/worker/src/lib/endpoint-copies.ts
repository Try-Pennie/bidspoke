/**
 * The two KV copies of a custom endpoint record (routes/custom-endpoint.ts) and
 * the one way to retire them (#1846). The endpoint route reads them and the
 * endpoint API routes retire them through this module, so the keys deleted are
 * the keys read.
 *
 * - The hot copy (`ep:`) expires after 60 seconds and saves a database lookup
 *   on every inbound lead.
 * - The last-good copy (`ep-lastgood:`) has no expiry and is served only when
 *   the webhook_endpoints lookup fails (#1296).
 *
 * Only the hot copy used to be deleted when an endpoint changed, so in a
 * database outage an endpoint deleted, switched off or moved minutes earlier
 * was still served from its last-good copy. Every route writing
 * webhook_endpoints now retires both copies under every address it touched,
 * after its write lands (a guard in
 * apps/web/src/lib/__guards__/worker/last-good-copies-retired.test.ts enumerates
 * those routes from source); the next successful lookup writes them afresh.
 *
 * The last-good copy is served for at most STORED_COPY_MAX_AGE_MS after it was
 * last confirmed (#1847). Every successful lookup confirms it (the hot copy
 * expires every 60 seconds, so a busy address is confirmed about once a
 * minute), and the per minute stored copy sweep confirms an idle address's copy
 * against its row, so an endpoint no lead has reached for an hour is still
 * served in an outage.
 */
import { confirmedAt, judgeCopyAge, readConfirmedCopy, refuseStoredCopy } from './stored-copy-age'
import { formatErr } from './format-error'

/** The endpoint record both copies hold. */
export interface CachedEndpoint {
  id: string
  workflow_id: string
  source_name: string
  is_active: boolean
  auth_method: 'api_key' | 'none'
}

/**
 * The copy of one endpoint row, from the row and its workflow trigger's
 * auth_method. The one derivation the lookup and the sweep both use, so the
 * sweep confirms exactly what the lookup would write.
 */
export function endpointCopyOf(row: { id: string; workflow_id: string; source_name: string; is_active: boolean }, triggerAuthMethod: unknown): CachedEndpoint {
  return {
    id: row.id,
    workflow_id: row.workflow_id,
    source_name: row.source_name,
    is_active: row.is_active,
    auth_method: triggerAuthMethod === 'none' ? 'none' : 'api_key',
  }
}

/** Whether two copies describe the same endpoint, field by field. */
export function sameEndpointCopy(a: Record<string, unknown>, b: CachedEndpoint): boolean {
  return a.id === b.id && a.workflow_id === b.workflow_id && a.source_name === b.source_name && a.is_active === b.is_active && a.auth_method === b.auth_method
}

/** The 60 second copy of the endpoint record at this address. */
export const endpointHotKey = (subdomain: string, path: string): string => `ep:${subdomain}:${path}`

/** The no-expiry copy served when the endpoint lookup fails. */
export const endpointLastGoodKey = (subdomain: string, path: string): string => `ep-lastgood:${subdomain}:${path}`

/**
 * Delete both copies at this address. Throws when KV refuses; a route runs it
 * through copyCleared (stored-copy.ts) and warns, and the sweep retries it.
 */
export async function retireEndpointCopies(kv: KVNamespace, subdomain: string, path: string): Promise<void> {
  await Promise.all([kv.delete(endpointHotKey(subdomain, path)), kv.delete(endpointLastGoodKey(subdomain, path))])
}

/** Write the last-good copy, stamped as confirmed at `nowMs`. Throws when KV refuses. */
export async function writeEndpointLastGood(kv: KVNamespace, subdomain: string, path: string, endpoint: CachedEndpoint, nowMs: number): Promise<void> {
  await kv.put(endpointLastGoodKey(subdomain, path), JSON.stringify(endpoint), confirmedAt(nowMs))
}

/**
 * The last-good copy for a lookup that failed, or null with the refusal logged:
 * no copy, a copy that does not parse, or one past the maximum age or with no
 * readable confirmation time (#1847). The caller answers a null with a
 * retryable refusal, exactly as for no copy.
 */
export async function readEndpointLastGood(kv: KVNamespace, subdomain: string, path: string, dbError: string, nowMs: number): Promise<CachedEndpoint | null> {
  const subject = `${subdomain}${path}`
  let held: Awaited<ReturnType<typeof readConfirmedCopy>>
  try {
    held = await readConfirmedCopy(kv, endpointLastGoodKey(subdomain, path))
  } catch (e) {
    // KV failing as well leaves nothing to serve: the same retryable answer.
    console.error(`[custom-endpoint] endpoint lookup failed (${dbError}) and the last-good copy of ${subject} could not be read: ${formatErr(e)}`)
    return null
  }
  let endpoint: CachedEndpoint | null = null
  if (held) {
    try {
      endpoint = JSON.parse(held.value) as CachedEndpoint
    } catch {
      endpoint = null
    }
  }
  if (!held || !endpoint || typeof endpoint !== 'object') {
    refuseStoredCopy({ copy: 'custom_endpoint', subject, reason: 'no_copy', ageMs: null, dbError })
    return null
  }
  const age = judgeCopyAge(held.confirmedAt, nowMs)
  if (!age.usable) {
    refuseStoredCopy({ copy: 'custom_endpoint', subject, reason: age.reason, ageMs: age.ageMs, dbError })
    return null
  }
  return endpoint
}
