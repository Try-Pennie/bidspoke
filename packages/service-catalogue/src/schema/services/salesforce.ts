import type { ServiceSchema } from '../types'

/**
 * Salesforce (#2338, PR 1 of its build plan): the connection only. Its actions
 * arrive with #2337, each in its own PR, and until then the entry exists so
 * the Add connection form can offer it. The ops service it connects through
 * (apps/worker/src/ops/connections/salesforce-service.ts) is registered ahead
 * of its actions.
 *
 * The login is the org's ops connected app, `{ client_id, client_secret }`;
 * the target is `{ instance_url, client_id }` (minters/salesforce.ts). The
 * client id goes into both, because the minter refuses a login whose client id
 * is not the declared one. Org is the declared instance, picked from the orgs
 * Bidspoke knows (D15). Who the connection acts as is never a field: verify
 * reads it from Salesforce (userinfo) when the login is checked.
 */
export const SALESFORCE_SERVICE: ServiceSchema = {
  key: 'salesforce',
  name: 'Salesforce',
  actions: [],
  connection: {
    tile: 'An org, signed in as its integration user',
    auth: 'client_credentials',
    fields: [
      { key: 'instance_url', label: 'Org', input: 'salesforce_org', required: true, target: 'instance_url' },
      { key: 'client_id', label: 'Client id', input: 'text', required: true, login: 'client_id', target: 'client_id' },
      { key: 'client_secret', label: 'Client secret', input: 'secret', required: true, login: 'client_secret' },
    ],
  },
}
