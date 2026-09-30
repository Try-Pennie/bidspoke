/**
 * One Salesforce record update from outside the engine (#1659), for a person's
 * action on a Bidspoke page (a held click marked sent).
 *
 * The same credentials the engine uses, resolved for the organization acting
 * through the one resolver (salesforce-creds.ts, #1174), and the same cached
 * token (getSalesforceToken). A non-2xx answer THROWS with the status and the
 * start of Salesforce's own error, so a caller reports a refusal by name rather
 * than reading it as written (L520).
 *
 * LOCAL DEV. There is one Salesforce org and it is production, so a wrangler dev
 * session is refused here the way lib/supabase.ts refuses a database write
 * (#669), unless ALLOW_PROD_WRITES is set in .dev.vars. It is inert on the
 * deployed Worker, where LOCAL_DEV is never set.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'
import { getSalesforceToken } from '../engine/nodes/salesforce'
import { requireSalesforceCreds, type SalesforceCreds } from './salesforce-creds'
import { SALESFORCE_API_VERSION } from './salesforce-read'

/** How long one update may take, the engine's own per call bound. */
export const SALESFORCE_UPDATE_TIMEOUT_MS = 15_000

/** A 15 or 18 character Salesforce id; anything else never reaches the URL. */
export const SALESFORCE_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/

export class SalesforceUpdateError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message)
    this.name = 'SalesforceUpdateError'
  }
}

export interface SalesforceUpdateDeps {
  fetch?: typeof fetch
  creds?: (env: Env, supabase: SupabaseClient, orgId: string, purpose: string) => Promise<SalesforceCreds>
  token?: (env: Env, orgId: string, instanceUrl: string, clientId: string, clientSecret: string) => Promise<string>
}

export async function salesforceUpdate(
  env: Env,
  supabase: SupabaseClient,
  orgId: string,
  object: string,
  recordId: string,
  body: Record<string, unknown>,
  purpose: string,
  deps: SalesforceUpdateDeps = {},
): Promise<void> {
  if (!SALESFORCE_ID.test(recordId)) throw new SalesforceUpdateError(`${JSON.stringify(recordId)} is not a Salesforce id, so no update was sent`, null)
  if (env.LOCAL_DEV && !env.ALLOW_PROD_WRITES) {
    throw new SalesforceUpdateError(
      `Blocked a Salesforce update of ${object} ${recordId}: local dev shares the production Salesforce org. Set ALLOW_PROD_WRITES=true in apps/worker/.dev.vars if you intend this (see issue #669).`,
      null,
    )
  }
  const creds = await (deps.creds ?? requireSalesforceCreds)(env, supabase, orgId, purpose)
  const token = await (deps.token ?? getSalesforceToken)(env, orgId, creds.instanceUrl, creds.clientId, creds.clientSecret)
  const doFetch = deps.fetch ?? fetch
  const res = await doFetch(`${creds.instanceUrl}/services/data/${SALESFORCE_API_VERSION}/sobjects/${object}/${recordId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SALESFORCE_UPDATE_TIMEOUT_MS),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new SalesforceUpdateError(`Salesforce refused the ${object} update (${res.status}): ${refusalText(text)}`, res.status)
  }
}

/**
 * Salesforce's error list, `[{ errorCode, message }]`, as a person reads it:
 * "UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record".
 * Anything else is passed on as its first 300 characters.
 */
export function refusalText(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body)
    if (Array.isArray(parsed) && parsed.length > 0) {
      const parts = parsed.map((e: unknown) => {
        const o = (e ?? {}) as { errorCode?: unknown; message?: unknown }
        return typeof o.errorCode === 'string' && typeof o.message === 'string' ? `${o.errorCode}: ${o.message}` : null
      })
      if (parts.every((p): p is string => p !== null)) return parts.join('; ').slice(0, 300)
    }
  } catch {
    // Not JSON: an HTML error page or plain text, passed on as it came.
  }
  return body.slice(0, 300) || 'no body'
}
