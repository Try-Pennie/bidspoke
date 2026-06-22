import { Hono } from 'hono'
import type { Env } from '../index'
import { apiKeyAuth, type Variables } from '../middleware/api-key-auth'
import { executeWorkflow, SourceNotAuthorizedError, SourceAuthUnavailableError } from '../engine/index'
import { WorkflowNotFoundError } from '../engine/definition-loader'
import { createSupabaseClient } from '../lib/supabase'

const webhooks = new Hono<{ Bindings: Env; Variables: Variables }>()

webhooks.post('/:workflow_id', apiKeyAuth, async (c) => {
  const workflowId = c.req.param('workflow_id') as string
  const source = c.get('source')
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
        enforceSourceAssignment: true,
      },
      c.env,
      supabase,
      c.executionCtx
    )

    const headers: Record<string, string> = {
      ...(result.responseHeaders ?? {}),
      'X-Trace-Id': result.traceId,
    }
    if (result.idempotentReplay) {
      headers['X-Idempotent-Replay'] = 'true'
    }

    // If the workflow set a non-JSON Content-Type, send the body as-is via c.body().
    // Otherwise default to c.json() which auto-sets application/json.
    const ct = headers['Content-Type'] ?? headers['content-type']
    if (ct && !ct.toLowerCase().startsWith('application/json')) {
      const body = typeof result.response === 'string' ? result.response : JSON.stringify(result.response)
      return c.body(body, result.status as 200 | 409 | 500, headers)
    }

    return c.json(result.response, result.status as 200 | 409 | 500, headers)
  } catch (err) {
    // Map known cases by error TYPE (not message substring) and return a
    // generic message to the external caller — never echo raw err.message,
    // which can leak internal/DB details (#107). The real error is logged.
    if (err instanceof SourceNotAuthorizedError) {
      return c.json({ error: 'Source not authorized for this workflow' }, 403)
    }
    // Couldn't verify the source→workflow restriction (DB error). Fail closed
    // with a retryable 503 rather than allowing the request (#65); the engine's
    // idempotency makes a sender retry safe.
    if (err instanceof SourceAuthUnavailableError) {
      return c.json({ error: 'Service temporarily unavailable' }, 503)
    }
    if (err instanceof WorkflowNotFoundError) {
      return c.json({ error: 'Workflow not found' }, 404)
    }

    console.error('[webhook] execution error:', err)
    return c.json({ error: 'Internal error' }, 500)
  }
})

export default webhooks
