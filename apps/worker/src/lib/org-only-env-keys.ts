/**
 * Environment variables a workflow cannot hold its own value for (#1681).
 *
 * The Salesforce node keeps ONE access token per organization
 * (`sf-token-<org>`, engine/nodes/salesforce.ts), shared with every scheduled
 * Salesforce job. A workflow with its own Salesforce connection would be handed
 * the organization's token, or leave its own under the organization's key for
 * every other workflow to send. So the connection is the organization's only,
 * refused by the env API for one workflow and never applied by the env loader
 * if a row reaches the table some other way. A workflow with a Salesforce org of
 * its own is #1689, which has to give the token a key per connection first.
 *
 * Its own module with no imports, so the credential resolver and the env loader
 * can both read it without importing each other.
 */

/** The three values that make up the organization's Salesforce connection (#1174). */
export const SALESFORCE_CRED_KEYS = [
  'SALESFORCE_INSTANCE_URL',
  'SALESFORCE_CLIENT_ID',
  'SALESFORCE_CLIENT_SECRET',
] as const

const ORG_ONLY: ReadonlySet<string> = new Set(SALESFORCE_CRED_KEYS)

export function isOrgOnlyEnvKey(key: string): boolean {
  return ORG_ONLY.has(key)
}
