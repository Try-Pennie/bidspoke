/**
 * The data picker's rows (@bidspoke/references sampleRows, #2338, #2339) name
 * references the engine really reads: every path a row offers is resolved here
 * through the engine's own resolver to the value its sample shows (L370).
 */
import { describe, expect, it } from 'vitest'
import { sampleRows } from '@bidspoke/references'
import { buildContext, resolveValue } from '../../engine/context'

const answer = {
  id: 42,
  ok: true,
  note: null,
  files: [{ name: 'a.csv', size: 10 }, { name: 'b.csv', size: 20 }],
  'Content-Type': 'text/csv',
  owner: { email: 'ops@trypennie.com' },
}

function context(output: unknown, payload: unknown) {
  const ctx = buildContext(payload, 'step_test', 'wf', 'exec', {}, 'org', 'exec')
  ctx.steps.find_files = { output, status: 'completed' }
  return ctx
}

describe('every picker row resolves through the engine', () => {
  it('a step output\'s rows, lists and items included, read the values their samples show', () => {
    const ctx = context(answer, {})
    const { rows } = sampleRows('steps.find_files.output', answer)
    expect(rows.length).toBeGreaterThan(8)
    for (const row of rows) {
      const value = resolveValue(`{{${row.path}}}`, ctx)
      expect(value, row.path).not.toBeUndefined()
      if (value === null || typeof value !== 'object') expect(String(value), row.path).toBe(row.sample)
    }
  })

  it('the trigger payload\'s rows read the payload', () => {
    const payload = { email: 'maria.lopez@example.com', first_name: 'Maria', enrolled_debt: 18450 }
    const ctx = context({}, payload)
    for (const row of sampleRows('trigger.payload', payload).rows) {
      expect(String(resolveValue(`{{${row.path}}}`, ctx)), row.path).toBe(row.sample)
    }
  })
})
