/**
 * A step that answers the lead inside a parallel block fails its slot, since
 * the run cannot answer while its siblings run. The failure names the step's
 * own type (#2590): it said "Code" for every step, so a lead validation step
 * placed there (one saved before the save rule refused it) read as a Code node
 * nobody could find.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../../lib/lead-validation-config-alert', () => ({ reportLeadValidationEvent: vi.fn().mockResolvedValue('nothing_due') }))

import { runParallelChild } from '../index'
import type { Env } from '../../index'
import type { ExecutionContext, NodeDefinition } from '../../types'
import type { StepLogEntry } from '../step-logger'

function makeCtx(): ExecutionContext {
  return {
    trigger: { payload: { leadUuid: 'lead-1', state: 'ZZ' }, source: 'test', workflow_id: 'wf', org_id: '', trace_id: 't' },
    steps: {},
    env: {},
    // Every engine run sets it (walkGraph); this workflow has no Constants step.
    constantsNamespaces: new Set<string>(),
  }
}

const validationChild: NodeDefinition = {
  id: 'v',
  namespace: 'validate_bidding_and_state',
  type: 'lead_validation',
  config: {
    lead_id_field: 'trigger.payload.leadUuid',
    retries: 0,
    checks: [{
      id: 'state',
      label: 'State',
      condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [{ field: 'trigger.payload.state', operator: 'in_array', value: ['TX'] }] }] },
      reason: 'ineligible state',
      on_missing: 'reject',
    }],
  },
}

describe('a step answering the lead inside a parallel block', () => {
  it('names the lead validation step by its own type, never as a Code node', async () => {
    const queue: StepLogEntry[] = []
    const result = await runParallelChild(
      validationChild, makeCtx(), {} as Env, null as unknown as SupabaseClient, 'money',
      'exec-1', new Date().toISOString(), 0, 'group-1', '', queue,
    )
    expect(result.status).toBe('rejected')
    const error = (result as { error?: string }).error ?? ''
    expect(error).toMatch(/^The lead validation step validate_bidding_and_state answered the lead inside a parallel block/)
    expect(error).toContain('Move it before the parallel block.')
    expect(error).not.toMatch(/\bCode\b/)
  })
})
