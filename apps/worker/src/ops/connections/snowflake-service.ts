/**
 * The ops Snowflake service as OpsConnections uses it (#2337, the first service
 * of phase 7 of #1689): the key pair minter (minters/snowflake.ts) with the host
 * its target declares, what verify measures (CURRENT_USER() and the account),
 * and where a schema lookup sends. Registered in services.ts.
 *
 * The login is `{ private_key }` (#2338's contract); the target is
 * `{ account, user }` with an optional `warehouse`, `role`, `database` and
 * `schema` for the session, read by the catalogue's Snowflake client
 * (@bidspoke/service-catalogue/runtime, snowflakeTargetOf), the same one the
 * Snowflake actions send their statements through, so verify and a step read a
 * target and talk to Snowflake one way.
 *
 * WHAT VERIFY MEASURES, AND WHY NOTHING IS RECORDED. The JWT names the declared
 * account and user, and Snowflake accepts it only when the key is that user's,
 * so the measured identity must be the declared one: verify asks Snowflake who
 * the credential is and refuses anything else (verify_identity_mismatch). Unlike
 * Salesforce, whose client_credentials login runs as a user no declaration
 * names, there is nothing further to remember about it: a different identity
 * needs a different target, which is a new generation. So verify writes no
 * measured identity row for Snowflake (connection_measured_identity is
 * Salesforce shaped, and its only reader is the Salesforce lease).
 *
 * What it cannot see: whether the declared user is one the bidding Worker's
 * export signs as. That is refused at save, on bidding, which holds those users
 * (Phase 8, #2338), not here.
 */
import { ActionFailure, rowObjects, runSnowflakeStatement, snowflakeHost, snowflakeTargetOf } from '@bidspoke/service-catalogue/runtime'
import { IdentityMismatch, IdentityUnreadable, type IdentityProbe } from './identity'
import { snowflakeKeyPairAuth } from './minters/snowflake'
import type { OpsServiceEntry, SchemaTarget } from './ops-connections'

/** Context functions only, which need no warehouse. */
const IDENTITY_STATEMENT =
  'SELECT CURRENT_USER() AS USER_NAME, CURRENT_ACCOUNT() AS ACCOUNT_LOCATOR, CURRENT_ACCOUNT_NAME() AS ACCOUNT_NAME, CURRENT_ORGANIZATION_NAME() AS ORGANIZATION_NAME'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const upper = (value: string) => value.trim().toUpperCase()
/** An account name in a URL writes its underscores as hyphens. */
const urlForm = (value: string) => upper(value).replace(/_/g, '-')

function nullableText(row: Record<string, unknown>, column: string): string | null {
  const value = row[column]
  if (value === null) return null
  if (typeof value !== 'string' || value.trim() === '') throw new IdentityUnreadable(`Snowflake answered no ${column}`)
  return value
}

/** Asks Snowflake, with the connection's own JWT, which user and account it is. */
export const snowflakeIdentity: IdentityProbe = {
  kind: 'snowflake',
  async measure(fetch, target) {
    const declared = snowflakeTargetOf(target)
    let row: Record<string, unknown>
    try {
      const rows = rowObjects(await runSnowflakeStatement({ fetch, sleep }, declared, { statement: IDENTITY_STATEMENT }))
      if (rows.length !== 1) throw new IdentityUnreadable(`Snowflake answered ${rows.length} rows to the identity query`)
      row = rows[0]
    } catch (err) {
      // Its code only: the failure's message quotes Snowflake.
      if (err instanceof ActionFailure) throw new IdentityUnreadable(`the identity query failed (${err.code})`)
      throw err
    }
    const user = nullableText(row, 'USER_NAME')
    const accountLocator = nullableText(row, 'ACCOUNT_LOCATOR')
    if (user === null || accountLocator === null) throw new IdentityUnreadable('Snowflake named no user or no account')
    const accountName = nullableText(row, 'ACCOUNT_NAME')
    const organizationName = nullableText(row, 'ORGANIZATION_NAME')

    if (upper(user) !== upper(declared.user)) throw new IdentityMismatch('the credential authenticates as another Snowflake user than its target declares')
    // The declared account is a locator (with its region after a dot) or org-account.
    const label = urlForm(declared.account.split('.')[0])
    const asNamed = organizationName !== null && accountName !== null ? `${urlForm(organizationName)}-${urlForm(accountName)}` : null
    if (label !== urlForm(accountLocator) && label !== asNamed) {
      throw new IdentityMismatch('the credential authenticates in another Snowflake account than its target declares')
    }
    return { kind: 'snowflake', accountLocator, organizationName, accountName, user }
  },
}

/** Where a Snowflake lookup sends: the declared account, in the declared database, which a lookup needs. */
export function snowflakeSchemaTarget(target: unknown, _publicConfig?: unknown): SchemaTarget {
  const declared = snowflakeTargetOf(target)
  if (declared.database === undefined) throw new Error('a Snowflake lookup needs the database its target declares')
  return { service: 'snowflake', account: declared.account, database: declared.database, ...(declared.schema !== undefined ? { schema: declared.schema } : {}) }
}

export function snowflakeServiceEntry(deps: { now(): number }): OpsServiceEntry {
  return {
    rules: {
      service: 'snowflake',
      declaredHosts: (target) => [snowflakeHost(snowflakeTargetOf(target).account)],
      ...snowflakeKeyPairAuth(deps),
    },
    identity: snowflakeIdentity,
    schema: snowflakeSchemaTarget,
  }
}
