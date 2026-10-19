import { SNOWFLAKE_SERVICE } from './services/snowflake'
import type { ServiceSchema } from './types'

/**
 * The shipped catalogue: every service and its actions, declaratively. Each
 * service arrives in its own PR of #2337 with its runtime half, its run files
 * and their fingerprints, and catalogue.test.ts holds them all to the same
 * checks. Snowflake was the first.
 */
export const CATALOGUE: readonly ServiceSchema[] = [SNOWFLAKE_SERVICE]
