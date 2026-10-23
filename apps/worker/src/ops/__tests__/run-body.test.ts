/**
 * What a live ops run executes (#2339): the walk, with app_action registered
 * as its one outside step, and nothing else, so a webhook or code step is still
 * refused by name before any step runs until it sends through the ledger.
 */
import { describe, expect, it } from 'vitest'
import { resolveRuntimeAction } from '@bidspoke/service-catalogue/runtime'
import { opsStepHandlers } from '../run-body'

describe('opsStepHandlers', () => {
  it('registers app_action, and only app_action', () => {
    const handlers = opsStepHandlers({
      appAction: { connection: () => { throw new Error('not reached') }, resolveAction: resolveRuntimeAction, sleep: async () => undefined },
    })
    expect(Object.keys(handlers)).toEqual(['app_action'])
  })
})
