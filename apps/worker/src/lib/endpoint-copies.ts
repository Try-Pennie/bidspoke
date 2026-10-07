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
 */

/** The 60 second copy of the endpoint record at this address. */
export const endpointHotKey = (subdomain: string, path: string): string => `ep:${subdomain}:${path}`

/** The no-expiry copy served when the endpoint lookup fails. */
export const endpointLastGoodKey = (subdomain: string, path: string): string => `ep-lastgood:${subdomain}:${path}`

/**
 * Delete both copies at this address. Throws when KV refuses, so a route cannot
 * report a clean success while a copy that should be gone is still served.
 */
export async function retireEndpointCopies(kv: KVNamespace, subdomain: string, path: string): Promise<void> {
  await Promise.all([kv.delete(endpointHotKey(subdomain, path)), kv.delete(endpointLastGoodKey(subdomain, path))])
}

/**
 * What an edit route answers when its row was saved and audited but a stored
 * outage copy could not be cleared (#1846). Retiring runs last, after the audit
 * and the other cache refreshes, so a failure here never leaves a saved change
 * unrecorded; saving again retries the clear.
 */
export const COPY_NOT_CLEARED_MESSAGE =
  'The change was saved and recorded, but its stored outage copy could not be cleared, so during a database outage the old version could still be served. Save it again to clear it.'

/**
 * Runs a stored copy's retirement, answering false (with the failure logged)
 * when KV refused it, so an edit route can report COPY_NOT_CLEARED_MESSAGE
 * after its audit and other refreshes rather than throwing past them (#1846).
 * The retire call is written at the call site, where the retired-copies guard
 * reads it.
 */
export async function copyCleared(retire: () => Promise<void>, what: string): Promise<boolean> {
  try {
    await retire()
    return true
  } catch (err) {
    console.error(`[stored-copy] ${what} could not be cleared: ${err instanceof Error ? err.message : 'unknown error'}`)
    return false
  }
}
