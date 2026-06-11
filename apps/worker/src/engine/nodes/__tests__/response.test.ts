import { describe, it, expect } from 'vitest'
import { executeResponseNode } from '../response'
import type { ExecutionContext, NodeDefinition } from '../../../types'

function ctx(overrides: { payload?: unknown; steps?: Record<string, unknown>; env?: Record<string, string> } = {}): ExecutionContext {
  return {
    trigger: { payload: overrides.payload ?? {}, source: 'test', workflow_id: 'wf', org_id: '', trace_id: 'trace' },
    steps: Object.fromEntries(
      Object.entries(overrides.steps ?? {}).map(([k, v]) => [k, { output: v, status: 'completed' as const }])
    ),
    env: overrides.env ?? {},
  }
}

function node(config: NodeDefinition['config']): NodeDefinition {
  return { id: 'n1', namespace: 'response_step', type: 'response', config }
}

describe('executeResponseNode', () => {
  describe('defaults', () => {
    it('returns status 200 with empty headers and null body by default', () => {
      const result = executeResponseNode(node({}), ctx())
      expect(result.output).toEqual({ status_code: 200, headers: {}, body: null })
    })
  })

  describe('static config', () => {
    it('uses configured status code', () => {
      const result = executeResponseNode(node({ status_code: 201 }), ctx())
      expect((result.output as { status_code: number }).status_code).toBe(201)
    })

    it('uses configured headers', () => {
      const result = executeResponseNode(node({ headers: { 'X-Custom': 'value' } }), ctx())
      expect((result.output as { headers: Record<string, string> }).headers).toEqual({ 'X-Custom': 'value' })
    })

    it('passes through a static body object', () => {
      const result = executeResponseNode(node({ body: { accepted: true, code: 42 } }), ctx())
      expect((result.output as { body: unknown }).body).toEqual({ accepted: true, code: 42 })
    })

    it('passes through a static string body', () => {
      const result = executeResponseNode(node({ body: 'OK' }), ctx())
      expect((result.output as { body: unknown }).body).toBe('OK')
    })
  })

  describe('templated status_code', () => {
    it('resolves {{steps.X.output.status}} to a number', () => {
      const result = executeResponseNode(
        node({ status_code: '{{steps.engine_call.output.status}}' }),
        ctx({ steps: { engine_call: { status: 502 } } })
      )
      expect((result.output as { status_code: number }).status_code).toBe(502)
    })

    it('coerces a stringified number to number', () => {
      const result = executeResponseNode(
        node({ status_code: '{{steps.engine_call.output.status_str}}' }),
        ctx({ steps: { engine_call: { status_str: '418' } } })
      )
      expect((result.output as { status_code: number }).status_code).toBe(418)
    })

    it('falls back to 200 when the template resolves to undefined', () => {
      const result = executeResponseNode(
        node({ status_code: '{{steps.missing.output.status}}' }),
        ctx()
      )
      expect((result.output as { status_code: number }).status_code).toBe(200)
    })

    it('numeric literal still works (back-compat)', () => {
      const result = executeResponseNode(node({ status_code: 201 }), ctx())
      expect((result.output as { status_code: number }).status_code).toBe(201)
    })
  })

  describe('template resolution in headers', () => {
    it('resolves {{trigger.payload.*}} references in header values', () => {
      const result = executeResponseNode(
        node({ headers: { 'X-Submission-Id': '{{trigger.payload.Submission__c}}' } }),
        ctx({ payload: { Submission__c: 'a04Ui00000IAdKHIA1' } })
      )
      expect((result.output as { headers: Record<string, string> }).headers).toEqual({
        'X-Submission-Id': 'a04Ui00000IAdKHIA1',
      })
    })

    it('coerces a non-string resolved value to string', () => {
      const result = executeResponseNode(
        node({ headers: { 'X-Score': '{{steps.credit.score}}' } }),
        ctx({ steps: { credit: { score: 720 } } })
      )
      expect((result.output as { headers: Record<string, string> }).headers['X-Score']).toBe('720')
    })

    it('supports inline interpolation in header values', () => {
      const result = executeResponseNode(
        node({ headers: { 'X-Trace': 'lead-{{trigger.payload.id}}' } }),
        ctx({ payload: { id: 'abc' } })
      )
      expect((result.output as { headers: Record<string, string> }).headers['X-Trace']).toBe('lead-abc')
    })

    it('omits a header whose template resolves to undefined', () => {
      const result = executeResponseNode(
        node({ headers: { 'X-Missing': '{{steps.missing.output.x}}', 'Content-Type': 'application/json' } }),
        ctx()
      )
      expect((result.output as { headers: Record<string, string> }).headers).toEqual({
        'Content-Type': 'application/json',
      })
    })

    it('leaves static header values untouched', () => {
      const result = executeResponseNode(
        node({ headers: { 'Content-Type': 'application/json' } }),
        ctx()
      )
      expect((result.output as { headers: Record<string, string> }).headers).toEqual({
        'Content-Type': 'application/json',
      })
    })

    it('resolved headers flow into earlyResponse with continue_after_response', () => {
      const result = executeResponseNode(
        node({
          headers: { 'X-Submission-Id': '{{trigger.payload.Submission__c}}' },
          continue_after_response: true,
        }),
        ctx({ payload: { Submission__c: 'sub-1' } })
      )
      expect(result.earlyResponse?.headers).toEqual({ 'X-Submission-Id': 'sub-1' })
    })
  })

  describe('template resolution in body', () => {
    it('resolves {{trigger.payload.*}} references', () => {
      const result = executeResponseNode(
        node({ body: { name: '{{trigger.payload.name}}' } }),
        ctx({ payload: { name: 'Alice' } })
      )
      expect((result.output as { body: { name: string } }).body.name).toBe('Alice')
    })

    it('resolves {{steps.namespace.*}} references', () => {
      const result = executeResponseNode(
        node({ body: { score: '{{steps.credit.score}}' } }),
        ctx({ steps: { credit: { score: 720 } } })
      )
      expect((result.output as { body: { score: unknown } }).body.score).toBe(720)
    })

    it('resolves {{env.KEY}} references', () => {
      const result = executeResponseNode(
        node({ body: { partner: '{{env.PARTNER_NAME}}' } }),
        ctx({ env: { PARTNER_NAME: 'Tripoint' } })
      )
      expect((result.output as { body: { partner: string } }).body.partner).toBe('Tripoint')
    })

    it('resolves inline interpolation within a string', () => {
      const result = executeResponseNode(
        node({ body: { message: 'Hello {{trigger.payload.name}}, your score is {{steps.credit.score}}.' } }),
        ctx({ payload: { name: 'Bob' }, steps: { credit: { score: 680 } } })
      )
      expect((result.output as { body: { message: string } }).body.message).toBe('Hello Bob, your score is 680.')
    })

    it('resolves templates recursively in nested objects', () => {
      const result = executeResponseNode(
        node({ body: { offer: { amount: '{{steps.bid.amount}}', currency: 'USD' } } }),
        ctx({ steps: { bid: { amount: 5000 } } })
      )
      expect((result.output as { body: { offer: { amount: unknown } } }).body.offer.amount).toBe(5000)
    })

    it('resolves templates in arrays', () => {
      const result = executeResponseNode(
        node({ body: ['{{trigger.payload.a}}', '{{trigger.payload.b}}'] }),
        ctx({ payload: { a: 1, b: 2 } })
      )
      expect((result.output as { body: unknown[] }).body).toEqual([1, 2])
    })

    it('returns undefined (empty string in interpolation) for missing references', () => {
      const result = executeResponseNode(
        node({ body: { val: '{{steps.missing.output.x}}' } }),
        ctx()
      )
      // Single expression with missing ref → resolves to undefined
      expect((result.output as { body: { val: unknown } }).body.val).toBeUndefined()
    })

    it('passes through non-string primitives unchanged', () => {
      const result = executeResponseNode(
        node({ body: { count: 42, active: true, nothing: null } }),
        ctx()
      )
      const body = (result.output as { body: Record<string, unknown> }).body
      expect(body.count).toBe(42)
      expect(body.active).toBe(true)
      expect(body.nothing).toBeNull()
    })
  })
})
