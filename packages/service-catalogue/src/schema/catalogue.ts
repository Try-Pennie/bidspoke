import { SALESFORCE_SERVICE } from './services/salesforce'
import { SNOWFLAKE_SERVICE } from './services/snowflake'
import type { ServiceSchema } from './types'

/**
 * The shipped catalogue: every service, its actions and its connection,
 * declaratively. Each service arrives in its own PR of #2337 with its runtime
 * half, its run files and their fingerprints, and catalogue.test.ts holds them
 * all to the same checks. Snowflake was the first; Salesforce's entry came
 * ahead of its actions, with its connection only (#2338).
 *
 * In the order the Add connection tiles are drawn, by name, as the settled
 * design lists them (schema/connection.test.ts holds that).
 */
export const CATALOGUE: readonly ServiceSchema[] = [SALESFORCE_SERVICE, SNOWFLAKE_SERVICE]
