/**
 * Money's Salesforce run as identity (#2335, PR 6 of phase 5 of #1689; plan:
 * discussion #2329, part 2, "the cross lane rule is an allowlist plus a measured
 * identity").
 *
 * WHY. An ops Salesforce connection must never act as money's integration user,
 * whatever client id it declares: pasting money's connected app while declaring
 * another, or declaring a new app that runs as money's user, would let ops
 * traffic spend money's Salesforce limits and write as money. Ops verify (PR 8)
 * measures what a credential authenticates as (/services/oauth2/userinfo) and
 * refuses when that equals money's. Money's own identity is measured here, on
 * the bidding Worker, which holds money's login; ops never sees that login.
 *
 * WHAT. Once a day (the 13:00 UTC batch, registered in CRON_JOBS as
 * MONEY_IDENTITY_JOB with its own heartbeat), for the one organization that
 * holds money's Salesforce credentials (resolveSalesforceCredentialOrg, which
 * refuses rather than guess when several do): money's token through the
 * existing getSalesforceToken, unchanged (a cache read, and a mint only when
 * the cache is empty, as every money caller does), then ONE userinfo call. The
 * org id and username it answers are kept in KV under the organization, with
 * the time measured. A failed measurement keeps the last reading (L5) and pages
 * through the shared export alerter, which holds a lone transient failure.
 * Nothing on the money path changes: no money module is edited, no cache is
 * written or cleared here, and the call takes no bulkhead slot (one call a day).
 *
 * SERVED. readMoneyIdentities answers OpsGateway.moneyIdentities(organizationId)
 * with that organization's reading only, keyed by it, so another organization's
 * can never be returned; no reading is null, which verify refuses by name
 * (money_identity_unmeasured), never a pass. Who may call it: only the ops Worker,
 * through its OPS_GATEWAY service binding; no public route reaches it. Whose
 * data: one organization's money Salesforce org id and username, non secret
 * identifiers. The token is never stored, logged or put in an error.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import { getSalesforceToken } from '../engine/nodes/salesforce'
import { notifyExportFailure } from './export-alerts'
import {
  OpsGatewayContractError, parseMoneySalesforceIdentity, type MoneySalesforceIdentity, type ServedMoneyIdentities,
} from './ops-gateway-contract'
import { salesforceInstanceUrl } from './salesforce-api'
import { requireSalesforceCreds, resolveSalesforceCredentialOrg, type SalesforceCreds } from './salesforce-creds'

/** The job's id in the heartbeat registry and the export alerter. Never rename it: it keys its KV state. */
export const MONEY_IDENTITY_JOB = 'money-identity'

/** Where one organization's reading is kept. */
export const moneySalesforceIdentityKey = (organizationId: string): string => `money-identity:salesforce:${organizationId}`

/** The userinfo call's deadline, body included. */
export const USERINFO_TIMEOUT_MS = 10_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
}

export interface MoneyIdentityDeps {
  kv: KvLike
  /** The organization holding money's Salesforce credentials (resolveSalesforceCredentialOrg). */
  credentialOrg(): Promise<{ orgId: string | null; error: string | null }>
  /** That organization's credentials (requireSalesforceCreds). Throws naming every missing one. */
  creds(organizationId: string): Promise<SalesforceCreds>
  /** Money's token (getSalesforceToken, unchanged). */
  token(organizationId: string, creds: SalesforceCreds): Promise<string>
  fetch: typeof fetch
  now(): number
  /** Defaults to USERINFO_TIMEOUT_MS. */
  timeoutMs?: number
}

export interface MoneyIdentityResult {
  organizationId: string | null
  measured: boolean
  /** Each a sentence naming the cause, never a value of the login or the token. */
  errors: string[]
}

const failed = (organizationId: string | null, error: string): MoneyIdentityResult => ({ organizationId, measured: false, errors: [error] })

/** The status a token failure carries, never its message, which can echo what was sent. */
function tokenFailure(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status
  return typeof status === 'number'
    ? `money's Salesforce token was refused (${status})`
    : 'money\'s Salesforce token had no answer (a network failure or a timeout)'
}

export async function measureMoneyIdentity(deps: MoneyIdentityDeps): Promise<MoneyIdentityResult> {
  const timeoutMs = deps.timeoutMs ?? USERINFO_TIMEOUT_MS
  const owner = await deps.credentialOrg()
  if (owner.orgId === null) return failed(null, `The money identity was not measured: ${owner.error ?? 'no organization holds money\'s Salesforce credentials'}.`)
  const organizationId = owner.orgId

  let creds: SalesforceCreds
  try {
    creds = await deps.creds(organizationId)
  } catch (err) {
    // requireSalesforceCreds names the missing settings, never their values.
    return failed(organizationId, `The money identity was not measured: ${(err as Error).message}.`)
  }
  let token: string
  try {
    token = await deps.token(organizationId, creds)
  } catch (err) {
    return failed(organizationId, `The money identity was not measured: ${tokenFailure(err)}.`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let status: number
  let text: string
  try {
    const res = await deps.fetch(`${salesforceInstanceUrl(creds.instanceUrl)}/services/oauth2/userinfo`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    status = res.status
    text = await res.text()
  } catch {
    return failed(organizationId, controller.signal.aborted
      ? `The money identity was not measured: Salesforce userinfo did not answer within ${timeoutMs} ms.`
      : 'The money identity was not measured: Salesforce userinfo had no answer (a network failure).')
  } finally {
    clearTimeout(timer)
  }
  // The body is never quoted: it is the user's record, and an error page can echo the request.
  if (status !== 200) return failed(organizationId, `The money identity was not measured: Salesforce userinfo answered ${status}.`)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return failed(organizationId, 'The money identity was not measured: Salesforce userinfo answered something that is not JSON.')
  }
  const b = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>
  let identity: MoneySalesforceIdentity
  try {
    identity = parseMoneySalesforceIdentity(
      { sf_org_id: b.organization_id, username: b.preferred_username, measured_at: new Date(deps.now()).toISOString() },
      'Salesforce userinfo\'s answer',
    )
  } catch (err) {
    return failed(organizationId, `The money identity was not measured: ${(err as Error).message}.`)
  }
  await deps.kv.put(moneySalesforceIdentityKey(organizationId), JSON.stringify({ organization_id: organizationId, ...identity }))
  return { organizationId, measured: true, errors: [] }
}

/**
 * One organization's money identities, for OpsGateway.moneyIdentities. Throws
 * by name when asked without an organization uuid, or when the kept reading is
 * unreadable or names another organization: a reading that cannot be trusted is
 * never answered as one, nor as unmeasured.
 */
export async function readMoneyIdentities(kv: Pick<KvLike, 'get'>, organizationId: unknown, nowMs: number): Promise<ServedMoneyIdentities> {
  if (typeof organizationId !== 'string' || !UUID.test(organizationId)) {
    throw new OpsGatewayContractError('the money identities were asked for with no organization uuid')
  }
  const servedAt = new Date(nowMs).toISOString()
  const raw = await kv.get(moneySalesforceIdentityKey(organizationId))
  if (raw === null) return { organization_id: organizationId, served_at: servedAt, salesforce: null }
  let kept: unknown
  try {
    kept = JSON.parse(raw)
  } catch {
    throw new OpsGatewayContractError('the kept money Salesforce identity is unreadable')
  }
  const keptOrg = (kept as { organization_id?: unknown } | null)?.organization_id
  if (keptOrg !== organizationId) throw new OpsGatewayContractError('the kept money Salesforce identity names another organization than the one it is kept under')
  return { organization_id: organizationId, served_at: servedAt, salesforce: parseMoneySalesforceIdentity(kept, 'the kept money Salesforce identity') }
}

const FIX =
  'Check that money\'s Salesforce credentials (SALESFORCE_INSTANCE_URL, SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET in the organization\'s environment variables) still work and that exactly one organization holds them. The next daily run measures again; until one succeeds, ops keeps the last reading, and with none ops refuses to verify a Salesforce connection.'

/** The daily run: measure, then page on a failure or stand an alert down on a success. */
export async function runMoneyIdentityForEnv(supabase: SupabaseClient, env: Env, nowMs: number = Date.now()): Promise<MoneyIdentityResult> {
  const result = await measureMoneyIdentity({
    kv: env.IDEMPOTENCY,
    credentialOrg: () => resolveSalesforceCredentialOrg(supabase),
    creds: (organizationId) => requireSalesforceCreds(env, supabase, organizationId, 'the money identity measurement'),
    token: (organizationId, c) => getSalesforceToken(env, organizationId, c.instanceUrl, c.clientId, c.clientSecret),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
  })
  console.log(JSON.stringify({ event: 'money_identity', measured: result.measured, errors: result.errors.length }))
  await notifyExportFailure(supabase, MONEY_IDENTITY_JOB, result.errors, env.IDEMPOTENCY, {
    title: 'Money\'s Salesforce identity could not be measured',
    fixHint: FIX,
  }, nowMs)
  return result
}
