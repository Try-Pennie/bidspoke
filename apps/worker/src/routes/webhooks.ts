import { Hono } from 'hono'
import type { Env } from '../index'
import { apiKeyAuth, type Variables } from '../middleware/api-key-auth'
import { executeWorkflow } from '../engine/index'
import { createSupabaseClient } from '../lib/supabase'

const webhooks = new Hono<{ Bindings: Env; Variables: Variables }>()

webhooks.post('/:workflow_id', apiKeyAuth, async (c) => {
  const workflowId = c.req.param('workflow_id') as string
  const source = c.get('source') as string
  const idempotencyKey = c.req.header('X-Idempotency-Key') ?? undefined

  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const supabase = createSupabaseClient(c.env)

  try {
    const result = await executeWorkflow(
      {
        workflowId,
        payload,
        source,
        idempotencyKeyHeader: idempotencyKey,
        isTest: false,
      },
      c.env,
      supabase,
      c.executionCtx
    )

    const headers: Record<string, string> = {
      'X-Trace-Id': result.traceId,
    }
    if (result.idempotentReplay) {
      headers['X-Idempotent-Replay'] = 'true'
    }

    return c.json(result.response, result.status as 200 | 409 | 500, headers)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error'

    // 404 for unknown/inactive workflows
    if (message.includes('not found') || message.includes('inactive')) {
      return c.json({ error: message }, 404)
    }

    return c.json({ error: message }, 500)
  }
})

export default webhooks
