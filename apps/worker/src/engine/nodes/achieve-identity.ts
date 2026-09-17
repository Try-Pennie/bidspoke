/**
 * Identifying headers for the three Achieve hosts.
 *
 * Why they exist: Achieve's Cloudflare firewall blocks Cloudflare's shared Workers
 * egress address (2a06:98c0:3600::103). Every Cloudflare Workers tenant leaves
 * from that address, another tenant's scanner tripped their suspicious-activity
 * threshold, and their OFAC country rule fires on it besides, because Cloudflare
 * geolocates its own shared range as Russia. From 2026-09-05 06:00 UTC to at
 * least 2026-09-10 every request we made to
 *
 *   oauth.prd.ffngcp.com          (Eligibility Scout token)
 *   fdrapis-gateway.prd.fdrgcp.com (Eligibility Scout eligibility)
 *   api.freedomfinancialnet.com   (Achieve offers)
 *
 * All three are Achieve's, behind one firewall. The hostnames still carry the
 * Freedom Financial Network name the company had before it became Achieve, which
 * is why a search for "achieve" does not find them.
 *
 * was refused with a 403 WAF page before reaching them. We cannot change the
 * address: a dedicated egress IP is a Cloudflare Enterprise add-on, and anything
 * we run on Workers leaves from the same place. Probing from the Worker's own
 * egress showed the block is on the address and not on request shape, so no
 * User-Agent or auth change reaches it.
 *
 * The agreed remedy (Achieve, 2026-09-09) is a Skip rule above their IP block,
 * scoped to those three hosts and keyed on these headers, which lets our traffic
 * through without unblocking the address for anyone else.
 *
 * There are two senders, and only one of them can import this module. The Achieve
 * Offers node is worker code and calls `achieveIdentityHeaders` below. The Eligibility
 * Scout call is a canvas code node running in its own sandboxed isolate, which
 * cannot import from the worker, so it builds the same two headers from a prop.
 * Both read the same secret (ACHIEVE_PARTNER_KEY) and send the same header names, but
 * nothing in this repo can check the Scout half: that script lives in the workflow
 * definition in the database, so a change to the names here does not reach it and
 * no scan can see the omission. What does report it is the field-presence check,
 * which is how the block was found in the first place, four days in, and since #1265
 * the block page detector: the Scout script's sandbox records every non-2xx response it
 * fetches, and the worker recognises a block page and alerts on the first sighting
 * (docs/partner-block-pages.md).
 */

/** The three Achieve hosts behind one firewall, so a block on one names the others (#1265). */
export const ACHIEVE_HOSTS = ['oauth.prd.ffngcp.com', 'fdrapis-gateway.prd.fdrgcp.com', 'api.freedomfinancialnet.com'] as const

/** Header naming us to their firewall. Not a credential; safe in a log. */
export const ACHIEVE_CLIENT_HEADER = 'X-Pennie-Client'

/** Header carrying the shared secret their Skip rule matches on. */
export const ACHIEVE_KEY_HEADER = 'X-Pennie-Key'

/** The client id we identify as. Constant, so there is one less thing to set. */
export const ACHIEVE_CLIENT_ID = 'pennie'

/**
 * The identifying headers for a request to one of the three Achieve hosts.
 *
 * A missing or blank key does NOT stop the request. Their rule would refuse it,
 * which is the state we are already in, and refusing to send would replace one
 * failure with a different one. It omits the key header rather than sending an
 * empty value, so "never set" and "set wrong" stay distinguishable in their
 * firewall log, and the client header still goes out so the request is ours.
 * A missing key is made loud by the required-secrets guard, not by this call.
 */
export function achieveIdentityHeaders(env: Record<string, string | undefined>): Record<string, string> {
  const key = (env.ACHIEVE_PARTNER_KEY ?? '').trim()
  return key === ''
    ? { [ACHIEVE_CLIENT_HEADER]: ACHIEVE_CLIENT_ID }
    : { [ACHIEVE_CLIENT_HEADER]: ACHIEVE_CLIENT_ID, [ACHIEVE_KEY_HEADER]: key }
}
