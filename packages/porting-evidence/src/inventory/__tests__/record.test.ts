import { describe, expect, it } from 'vitest'
import { parseDecisionArgs, recordDecision } from '../record.ts'
import { PAGE, readDecisions } from '../store.ts'
import { fakeFetch, type Call } from './fake-fetch.ts'

const URL_ = 'https://example.supabase.co'
const KEY = 'service-key'
const NOW = '2026-10-28T12:00:00.000Z'

const inventoryRow = (stage: string) => ({
  pipedream_hashid: 'p_thread', name: 'Thread workflow', porting_stage: stage,
  retired_by: stage === 'retired' ? 'Test person' : null, retired_reason: stage === 'retired' ? 'Behind an End Workflow' : null, retired_at: stage === 'retired' ? '2026-10-28T12:00:00+00:00' : null,
})
const droppedRow = { pipedream_hashid: 'p_thread', step: 'normalize_thread_id', dropped_by: 'Test person', reason: 'Reads a deleted thread', dropped_at: '2026-10-28T12:00:00+00:00' }

/** A small Data API over one inventory row and its dropped steps, which applies the filtered writes the recorder sends. */
function dataApi(stage: string, dropped: Array<typeof droppedRow> = []) {
  const state = { row: inventoryRow(stage) as Record<string, unknown>, dropped: [...dropped] }
  const answer = (c: Call): Response => {
    const u = new URL(c.url)
    const table = u.pathname.split('/').at(-1)
    const q = u.searchParams
    if (table === 'pipedream_inventory') {
      const matches = q.get('pipedream_hashid') === `eq.${String(state.row.pipedream_hashid)}` && (!q.has('porting_stage') || q.get('porting_stage') === `eq.${String(state.row.porting_stage)}`)
      if (c.method === 'GET') return Response.json(matches ? [state.row] : [])
      if (c.method === 'PATCH') {
        if (!matches) return Response.json([])
        state.row = { ...state.row, ...(c.body as Record<string, unknown>) }
        return Response.json([state.row])
      }
    }
    if (table === 'dropped_steps') {
      if (c.method === 'GET') return Response.json(state.dropped)
      if (c.method === 'POST') {
        state.dropped.push(...(c.body as Array<typeof droppedRow>))
        return Response.json(c.body)
      }
      if (c.method === 'DELETE') {
        const gone = state.dropped.filter((d) => q.get('step') === `eq.${d.step}`)
        state.dropped = state.dropped.filter((d) => !gone.includes(d))
        return Response.json(gone)
      }
    }
    return new Response('unexpected', { status: 400 })
  }
  return { state, ...fakeFetch(answer) }
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET')

describe('recordDecision (#2979)', () => {
  it('prints its plan and writes nothing without --apply', async () => {
    const { f, calls, state } = dataApi('none')
    const lines = await recordDecision(f, URL_, KEY, { kind: 'retire', hashid: 'p_thread', by: 'Test person', reason: 'Behind an End Workflow' }, { apply: false, now: NOW, exportSteps: null })
    expect(writes(calls)).toEqual([])
    expect(state.row.porting_stage).toBe('none')
    expect(lines.join('\n')).toMatch(/Retire p_thread/)
    expect(lines.at(-1)).toMatch(/Nothing written/)
  })

  it('writes nothing for a dropped step either without --apply', async () => {
    const { f, calls } = dataApi('none')
    await recordDecision(f, URL_, KEY, { kind: 'drop_step', hashid: 'p_thread', step: 'normalize_thread_id', by: 'Test person', reason: 'Reads a deleted thread' }, { apply: false, now: NOW, exportSteps: ['normalize_thread_id'] })
    expect(writes(calls)).toEqual([])
  })

  it('retires with --apply only while the stage is still none, then reads the decision back', async () => {
    const { f, calls, state } = dataApi('none')
    const lines = await recordDecision(f, URL_, KEY, { kind: 'retire', hashid: 'p_thread', by: 'Test person', reason: 'Behind an End Workflow' }, { apply: true, now: NOW, exportSteps: null })
    const [patch] = writes(calls)
    expect(patch.method).toBe('PATCH')
    expect(new URL(patch.url).searchParams.get('porting_stage')).toBe('eq.none')
    expect(patch.headers['content-profile']).toBe('porting')
    expect(patch.body).toEqual({ porting_stage: 'retired', retired_by: 'Test person', retired_reason: 'Behind an End Workflow', retired_at: NOW, updated_at: NOW })
    expect(state.row.porting_stage).toBe('retired')
    expect(lines.at(-1)).toMatch(/read back/i)
  })

  it('refuses when the stage changed between the read and the write, rather than reporting success', async () => {
    const { f, state } = dataApi('none')
    const racing = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PATCH') state.row.porting_stage = 'drafted'
      return f(input, init)
    }) as typeof fetch
    await expect(recordDecision(racing, URL_, KEY, { kind: 'retire', hashid: 'p_thread', by: 'A', reason: 'B' }, { apply: true, now: NOW, exportSteps: null })).rejects.toThrow(/0 row/)
  })

  it('drops and keeps a step with --apply', async () => {
    const dropping = dataApi('none')
    await recordDecision(dropping.f, URL_, KEY, { kind: 'drop_step', hashid: 'p_thread', step: 'normalize_thread_id', by: 'Test person', reason: 'Reads a deleted thread' }, { apply: true, now: NOW, exportSteps: ['normalize_thread_id'] })
    expect(writes(dropping.calls).map((c) => [c.method, c.body])).toEqual([['POST', [{ pipedream_hashid: 'p_thread', step: 'normalize_thread_id', dropped_by: 'Test person', reason: 'Reads a deleted thread', dropped_at: NOW }]]])

    const keeping = dataApi('none', [droppedRow])
    await recordDecision(keeping.f, URL_, KEY, { kind: 'keep_step', hashid: 'p_thread', step: 'normalize_thread_id' }, { apply: true, now: NOW, exportSteps: null })
    const [del] = writes(keeping.calls)
    expect(del.method).toBe('DELETE')
    expect(new URL(del.url).searchParams.get('step')).toBe('eq.normalize_thread_id')
    expect(keeping.state.dropped).toEqual([])
  })

  it('undoes a retirement, clearing who and why with the stage', async () => {
    const { f, calls, state } = dataApi('retired')
    await recordDecision(f, URL_, KEY, { kind: 'unretire', hashid: 'p_thread' }, { apply: true, now: NOW, exportSteps: null })
    expect(new URL(writes(calls)[0].url).searchParams.get('porting_stage')).toBe('eq.retired')
    expect(state.row).toMatchObject({ porting_stage: 'none', retired_by: null, retired_reason: null, retired_at: null })
  })
})

describe('readDecisions (#2979)', () => {
  it('reads every retirement and every dropped step, paging each in its unique order', async () => {
    const steps = Array.from({ length: PAGE }, (_, i) => ({ ...droppedRow, step: `s_${String(i).padStart(4, '0')}` }))
    const { f, calls } = fakeFetch((c) => {
      const u = new URL(c.url)
      if (u.pathname.endsWith('/pipedream_inventory')) {
        const { pipedream_hashid, retired_by, retired_reason, retired_at } = inventoryRow('retired')
        return Response.json([{ pipedream_hashid, retired_by, retired_reason, retired_at }])
      }
      return Response.json(u.searchParams.get('offset') === '0' ? steps : [droppedRow])
    })
    const d = await readDecisions(f, URL_, KEY)
    expect(d.retired).toEqual([{ pipedream_hashid: 'p_thread', retired_by: 'Test person', retired_reason: 'Behind an End Workflow', retired_at: '2026-10-28T12:00:00+00:00' }])
    expect(d.dropped).toHaveLength(PAGE + 1)
    const inventoryRead = new URL(calls[0].url)
    expect(inventoryRead.searchParams.get('porting_stage')).toBe('eq.retired')
    expect(inventoryRead.searchParams.get('select')).toBe('pipedream_hashid,retired_by,retired_reason,retired_at')
    expect(inventoryRead.searchParams.get('order')).toBe('pipedream_hashid.asc')
    expect(new URL(calls[1].url).searchParams.get('order')).toBe('pipedream_hashid.asc,step.asc')
    expect(calls[0].headers['accept-profile']).toBe('porting')
  })

  it('throws when a read fails, rather than reading as no decisions', async () => {
    const { f } = fakeFetch(() => new Response('{"code":"42P01"}', { status: 404 }))
    await expect(readDecisions(f, URL_, KEY)).rejects.toThrow(/404/)
  })
})

describe('parseDecisionArgs (#2979)', () => {
  it('reads each mode', () => {
    expect(parseDecisionArgs(['--retire', 'p_thread', '--by', 'Test person', '--reason', 'Dead'])).toEqual({ request: { kind: 'retire', hashid: 'p_thread', by: 'Test person', reason: 'Dead' }, exportDir: null, apply: false })
    expect(parseDecisionArgs(['--unretire', 'p_thread', '--apply'])).toEqual({ request: { kind: 'unretire', hashid: 'p_thread' }, exportDir: null, apply: true })
    expect(parseDecisionArgs(['--drop-step', 'p_thread', '--step', 'normalize_thread_id', '--export', '/x', '--by', 'A', '--reason', 'B'])).toEqual({ request: { kind: 'drop_step', hashid: 'p_thread', step: 'normalize_thread_id', by: 'A', reason: 'B' }, exportDir: '/x', apply: false })
    expect(parseDecisionArgs(['--keep-step', 'p_thread', '--step', 'shape'])).toEqual({ request: { kind: 'keep_step', hashid: 'p_thread', step: 'shape' }, exportDir: null, apply: false })
  })

  it('refuses no mode, two modes, a bad hashid, and a drop without its export', () => {
    expect(() => parseDecisionArgs(['--by', 'A'])).toThrow(/usage/)
    expect(() => parseDecisionArgs(['--retire', 'p_a', '--unretire', 'p_a'])).toThrow(/one of/)
    expect(() => parseDecisionArgs(['--retire', 'thread', '--by', 'A', '--reason', 'B'])).toThrow(/not a Pipedream workflow id/)
    expect(() => parseDecisionArgs(['--drop-step', 'p_a', '--step', 's', '--by', 'A', '--reason', 'B'])).toThrow(/--export/)
    expect(() => parseDecisionArgs(['--retire', 'p_a', '--reason', 'B'])).toThrow(/--by/)
  })
})
