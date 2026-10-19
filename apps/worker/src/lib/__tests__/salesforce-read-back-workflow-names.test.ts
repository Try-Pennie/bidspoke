/**
 * The workflow names an alert from the Salesforce read-back carries (#1437).
 *
 * The names are read with `.in('id', ids)`, and PostgREST answers at most 1,000
 * rows a request whatever the list asked for. The read runs against the real
 * supabase-js through a PostgREST double that cuts every answer at that cap, so
 * a read that sends the whole list at once loses every name past the cap here
 * exactly as it would in production.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fakePostgrest } from '../../__tests__/helpers/postgrest-fake'
import { readWorkflowNames, WORKFLOW_NAMES_CHUNK } from '../salesforce-read-back'

const workflows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `wf-${String(i).padStart(5, '0')}`, name: `Workflow ${i}` }))

describe('readWorkflowNames', () => {
  it('names every workflow asked for, even past the 1,000 row cap', async () => {
    const rows = workflows(1_200)
    const db = fakePostgrest({ workflows: rows }, {}, { rowCap: 1_000 })
    const names = await readWorkflowNames(db.client, rows.map((w) => w.id))
    expect(names.size).toBe(1_200)
    expect(names.get('wf-01199')).toBe('Workflow 1199')
  })

  it('asks for at most one chunk of ids a request, so no answer can reach the cap', async () => {
    const rows = workflows(250)
    const db = fakePostgrest({ workflows: rows }, {}, { rowCap: 1_000 })
    await readWorkflowNames(db.client, rows.map((w) => w.id))
    const sizes = db.requests.map((r) => (r.params.get('id') ?? '').split(',').length)
    expect(sizes.length).toBe(Math.ceil(250 / WORKFLOW_NAMES_CHUNK))
    expect(Math.max(...sizes)).toBeLessThanOrEqual(WORKFLOW_NAMES_CHUNK)
    expect(WORKFLOW_NAMES_CHUNK).toBeLessThanOrEqual(1_000)
  })

  it('throws on a failed read, so the alert falls back to "A workflow" rather than naming none silently', async () => {
    const failing = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { message: 'statement timeout' } }) }) }) }
    await expect(readWorkflowNames(failing as unknown as SupabaseClient, ['wf-1'])).rejects.toThrow('statement timeout')
  })

  it('asks nothing for no ids', async () => {
    const db = fakePostgrest({ workflows: workflows(3) }, {}, { rowCap: 1_000 })
    expect((await readWorkflowNames(db.client, [])).size).toBe(0)
    expect(db.requests).toHaveLength(0)
  })
})
