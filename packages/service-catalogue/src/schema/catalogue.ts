import type { ServiceSchema } from './types'

/**
 * The shipped catalogue: every service and its actions, declaratively. Empty
 * until the first service PR of #2337 adds one; each later service arrives in
 * its own PR with its runtime half, its run files and their fingerprints, and
 * catalogue.test.ts holds them all to the same checks.
 */
export const CATALOGUE: readonly ServiceSchema[] = []
