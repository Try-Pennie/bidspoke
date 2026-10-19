/**
 * The ops Salesforce service as OpsConnections uses it (#2335, PR 8 of phase 5
 * of #1689; registered in services.ts by #2337, phase 7): the
 * client_credentials minter (minters/salesforce.ts) with its declared host,
 * what verify measures (userinfo), and where a schema lookup sends (the
 * declared instance). No catalogue action uses it yet.
 *
 * Every request takes a lease from the ops pool first (connectionFetch), and
 * acquire_sf_lease grants it only within the caps Dan approved (Decision 11,
 * ops migration 20261020010000, the trypennie org and its instance host only so
 * far) and refuses the rest by name: verify of a connection not yet measured asks the bootstrap
 * slot of its declared host and is refused sf_cap_unset while that host has
 * no approved row; any other call before verify has measured the org is
 * sf_org_unmeasured; a measured org with no approved cap is sf_cap_unset. The
 * lease comes before the login, so a refused call asks no token either.
 *
 * Verify asks the bidding Worker for money's run as identity before anything
 * else (OPS_GATEWAY.moneyIdentities, which the bidding Worker's daily
 * money-identity job measures), refuses a credential that authenticates as it,
 * and records what it measured under the generation (record_measured_identity),
 * which is the row the lease's org pool is keyed on.
 *
 * The target is `{ instance_url, client_id }`; the login `{ client_id,
 * client_secret }` of the org's ops connected app (docs/ops-connections-logins.md).
 */
import { ConnectionRefusal, LoginMintError } from './refusals'
import { IdentityUnreadable, type IdentityProbe } from './identity'
import { salesforceClientCredentialsAuth, salesforceInstanceOf } from './minters/salesforce'
import type { MinterClockDeps } from './minters/token-endpoint'
import type { OpsServiceEntry, SchemaTarget } from './ops-connections'

/** The 18 character org id userinfo answers, the form the ops pool is keyed on. */
const SF_ORG_ID_18 = /^00D[A-Za-z0-9]{15}$/
const MAX_USERNAME = 320

function instanceOrigin(target: unknown): string {
  try {
    return salesforceInstanceOf(target).origin
  } catch (err) {
    if (err instanceof LoginMintError) throw new ConnectionRefusal('connection_target_invalid', 'the Salesforce connection\'s target does not declare an https Salesforce instance_url')
    throw err
  }
}

/** /services/oauth2/userinfo, asked with the connection's own token: the org and the user the credential runs as. */
export const salesforceIdentity: IdentityProbe = {
  kind: 'salesforce',
  async measure(fetch, target) {
    const res = await fetch(`${instanceOrigin(target)}/services/oauth2/userinfo`, { method: 'GET', headers: { accept: 'application/json' } })
    if (res.status !== 200) {
      res.body?.cancel().catch(() => undefined)
      throw new IdentityUnreadable(`Salesforce userinfo answered HTTP ${res.status}`)
    }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      // The body is never quoted: it is the user's record.
      throw new IdentityUnreadable('Salesforce userinfo answered something that is not JSON')
    }
    const b = (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
    const orgId = b.organization_id
    const username = b.preferred_username
    if (typeof orgId !== 'string' || !SF_ORG_ID_18.test(orgId)) throw new IdentityUnreadable('Salesforce userinfo named no 18 character org id')
    if (typeof username !== 'string' || username.trim() === '' || username.length > MAX_USERNAME) throw new IdentityUnreadable('Salesforce userinfo named no username')
    return { kind: 'salesforce', sfOrgId: orgId, username }
  },
}

/** Where a Salesforce lookup sends: the declared instance. */
export function salesforceSchemaTarget(target: unknown): SchemaTarget {
  return { service: 'salesforce', instanceUrl: instanceOrigin(target) }
}

/** The minter asks its token endpoint through connectionFetch (AuthorizeInput.fetch), so the entry needs only a clock. */
export function salesforceServiceEntry(deps: MinterClockDeps): OpsServiceEntry {
  const minter = salesforceClientCredentialsAuth(deps)
  return {
    rules: { service: 'salesforce', declaredHosts: (target) => [minter.salesforce!.instanceHost(target)], ...minter },
    identity: salesforceIdentity,
    schema: salesforceSchemaTarget,
  }
}
