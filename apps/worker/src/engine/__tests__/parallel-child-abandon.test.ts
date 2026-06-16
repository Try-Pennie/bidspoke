/**
 * Issue #63: a parallel child that completes AFTER the group stopped waiting
 * (timeout / first-winner / specific) must NOT write a second step row or
 * overwrite ctx.steps — the parent already wrote a synthesized timeout row.
 * runParallelChild checks the abandon signal right before it records/logs.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runParallelChild } from '../index'
import type { Env } from '../../index'
import type { ExecutionContext, NodeDefinition } from '../../types'
import type { StepLogEntry } from '../step-logger'

function makeCtx(): ExecutionContext {
  return {
    trigger: { payload: { score: 700 }, source: 'test', workflow_id: 'wf', org_id: '', trace_id: 't' },
    steps: {},
    env: {},
  }
}

// A filter child runs synchronously with no env/supabase, so it reaches the
// record/log point quickly.
const filterChild: NodeDefinition = {
  id: 'c1', namespace: 'gate', type: 'filter',
  config: { operation: 'continue_if', condition: { field: 'trigger.payload.score', operator: 'gt', value: '600' } },
}

describe('runParallelChild — abandonment guard (#63)', () => {
  it('does NOT record or log when the abandon signal is already aborted', async () => {
    const ctx = makeCtx()
    const queue: StepLogEntry[] = []
    const abandon = new AbortController()
    abandon.abort() // group already stopped waiting

    const result = await runParallelChild(
      filterChild, ctx, {} as Env, null as unknown as SupabaseClient,
      'exec-1', new Date().toISOString(), 0, 'group-1', '', queue,
      undefined, undefined, abandon.signal
    )

    expect(result.status).toBe('timeout')        // returns abandoned, value is discarded by the parent
    expect(queue).toHaveLength(0)                 // no second step-log row
    expect(ctx.steps['gate']).toBeUndefined()     // ctx.steps left for the parent's synthesized row
  })

  it('records and logs normally when not abandoned', async () => {
    const ctx = makeCtx()
    const queue: StepLogEntry[] = []

    const result = await runParallelChild(
      filterChild, ctx, {} as Env, null as unknown as SupabaseClient,
      'exec-1', new Date().toISOString(), 0, 'group-1', '', queue
      // no abandon signal
    )

    expect(result.status).toBe('fulfilled')
    expect(queue.length).toBeGreaterThan(0)       // step row written
    expect(ctx.steps['gate']?.status).toBe('completed')
  })
})
