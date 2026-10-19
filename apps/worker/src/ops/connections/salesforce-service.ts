/**
 * The ops Salesforce service as OpsConnections uses it (#2335, PR 8 of phase 5
 * of #1689): the client_credentials minter (minters/salesforce.ts) with its
 * declared host, what verify measures (userinfo), and where a schema lookup
 * sends (the declared instance). The catalogue's Salesforce runtime entry
 * (Phase 7) registers it on the ops Worker; until then no service is registered
 * (services.ts) and every ops Salesforce call is refused by name, and the ops
 * pool refuses every one anyway until Dan approves its cap (Decision 11).
 *
 * The target is `{ instance_url, client_id }`; the login `{ client_id,
 * client_secret }` of the org's ops connected app (docs/ops-connections-logins.md).
 */
import { ConnectionRefusal, LoginMintError } from './refusals'
import { IdentityUnreadable, type IdentityProbe } from './identity'
import { salesforceClientCredentialsAuth, salesforceInstanceOf } from './minters/salesforce'
import type { TokenEndpointDeps } from './minters/token-endpoint'
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

export function salesforceServiceEntry(deps: TokenEndpointDeps): OpsServiceEntry {
  const minter = salesforceClientCredentialsAuth(deps)
  return {
    rules: { service: 'salesforce', declaredHosts: (target) => [minter.salesforce!.instanceHost(target)], ...minter },
    identity: salesforceIdentity,
    schema: salesforceSchemaTarget,
  }
}
