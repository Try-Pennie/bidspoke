/**
 * One read against the Salesforce REST API for the daily checks, through the one
 * credential resolver (#1174) and the cached per-organization token.
 *
 * The checks that read Salesforce on a schedule (the Tripoint pricing check,
 * the Tripoint Lead status check) all need the same four steps: find the
 * organization holding the credentials, load them, get a token, and GET a path
 * under the versioned data API. This is that, once.
 *
 * A NON-2XX ANSWER THROWS with the status and the start of the body, so a
 * caller reports the 401 or 403 by name rather than reading an error page as
 * an answer (L98, L520).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { parseJson } from './json'
import { getSalesforceToken } from '../engine/nodes/salesforce'
import { requireSalesforceCreds, resolveSalesforceCredentialOrg } from './salesforce-creds'
import type { Env } from '../index'

export const SALESFORCE_API_VERSION = 'v60.0'

/**
 * GET `/services/data/<version>/<path>` and parse the JSON body. `purpose` names
 * the caller in the missing credentials message.
 */
export async function salesforceGet<T>(env: Env, supabase: SupabaseClient, path: string, purpose: string): Promise<T> {
  const { orgId, error } = await resolveSalesforceCredentialOrg(supabase)
  if (!orgId) throw new Error(error ?? 'no_org_holds_salesforce_credentials')
  const { instanceUrl, clientId, clientSecret } = await requireSalesforceCreds(env, supabase, orgId, purpose)
  const token = await getSalesforceToken(env, orgId, instanceUrl, clientId, clientSecret)

  const res = await fetch(`${instanceUrl}/services/data/${SALESFORCE_API_VERSION}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Salesforce ${path.split('?')[0]} failed (${res.status}): ${text.slice(0, 500)}`)
  }
  return parseJson<T>(res)
}

/**
 * Every record a SOQL query matches, following `nextRecordsUrl` page by page.
 * Refuses past `maxRecords` rather than returning part of the answer, so a
 * caller never judges a population it only read the start of (L211).
 */
export async function salesforceRows(
  env: Env,
  supabase: SupabaseClient,
  soql: string,
  purpose: string,
  maxRecords: number,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  const prefix = `/services/data/${SALESFORCE_API_VERSION}/`
  let path: string | undefined = `query?q=${encodeURIComponent(soql)}`
  while (path) {
    const body: { records?: unknown; done?: unknown; nextRecordsUrl?: unknown } = await salesforceGet(env, supabase, path, purpose)
    if (!Array.isArray(body.records)) throw new Error(`Salesforce answered a query with no records array: ${JSON.stringify(body).slice(0, 200)}`)
    out.push(...(body.records as Array<Record<string, unknown>>))
    if (out.length > maxRecords) throw new Error(`more than ${maxRecords} records matched, so none were used rather than part of them`)
    if (body.done === true) break
    if (typeof body.nextRecordsUrl !== 'string' || !body.nextRecordsUrl.startsWith(prefix)) {
      throw new Error(`Salesforce said the query was not done but gave no next page: ${JSON.stringify(body.nextRecordsUrl)}`)
    }
    path = body.nextRecordsUrl.slice(prefix.length)
  }
  return out
}

/**
 * The number of records a `SELECT COUNT() FROM ...` query matches. Throws when
 * the answer carries no count, so a changed response shape is a refusal and
 * never a zero (L90).
 */
export async function salesforceCount(env: Env, supabase: SupabaseClient, soql: string, purpose: string): Promise<number> {
  const body = await salesforceGet<{ totalSize?: unknown }>(env, supabase, `query?q=${encodeURIComponent(soql)}`, purpose)
  if (typeof body.totalSize !== 'number') {
    throw new Error(`Salesforce answered a COUNT() query with no totalSize: ${JSON.stringify(body).slice(0, 200)}`)
  }
  return body.totalSize
}
