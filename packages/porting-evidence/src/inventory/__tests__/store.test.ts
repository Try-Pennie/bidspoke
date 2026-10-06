import { describe, expect, it } from 'vitest'
import type { InventoryRow } from '../plan-load.ts'
import { PAGE, differencesAfterWrite, readStoredRows, writeRows } from '../store.ts'

const URL_ = 'https://example.supabase.co'
const KEY = 'service-key'

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

function fakeFetch(answer: (call: Call) => Response) {
  const calls: Call[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    return answer(call)
  }) as typeof fetch
  return { f, calls }
}

const row = (h: string): InventoryRow => ({
  organization_id: 'o', pipedream_hashid: h, project_hashid: 'proj_A', name: h, pipedream_state: 'on', definition_sha256: null,
  trigger_types: [], step_count: 0, deployment_count: 0, first_seen_export_at: '2026-09-30T19:26:13Z', last_seen_export_at: '2026-09-30T19:26:13Z', absent_since_export_at: null,
})

describe('readStoredRows (#1710)', () => {
  it('pages through the porting schema ordered by the unique hashid until a short page (L746)', async () => {
    const first = Array.from({ length: PAGE }, (_, i) => row(`p_${String(i).padStart(4, '0')}`))
    const { f, calls } = fakeFetch((c) => Response.json(c.url.includes('offset=0') ? first : [row('p_last')]))
    const rows = await readStoredRows(f, URL_, KEY)
    expect(rows).toHaveLength(PAGE + 1)
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toContain('/rest/v1/pipedream_inventory?')
    expect(calls[0].url).toContain('order=pipedream_hashid.asc')
    expect(calls[0].url).toContain(`limit=${PAGE}`)
    expect(calls[1].url).toContain(`offset=${PAGE}`)
    expect(calls[0].headers['accept-profile']).toBe('porting')
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`)
    expect(calls[0].url).not.toContain('porting_stage')
  })

  it('throws with the status and body when the read fails, rather than reading as empty', async () => {
    const { f } = fakeFetch(() => new Response('{"code":"PGRST106","message":"Invalid schema: porting"}', { status: 406 }))
    await expect(readStoredRows(f, URL_, KEY)).rejects.toThrow(/406.*PGRST106/)
  })

  it('throws when the answer is not a list', async () => {
    const { f } = fakeFetch(() => Response.json({ rows: [] }))
    await expect(readStoredRows(f, URL_, KEY)).rejects.toThrow(/not a list/)
  })
})

describe('writeRows (#1710)', () => {
  it('upserts on the hashid in batches and returns the number of rows the database reports', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => row(`p_${i}`))
    const { f, calls } = fakeFetch((c) => Response.json((c.body as unknown[]).map(() => ({}))))
    const n = await writeRows(f, URL_, KEY, rows, '2026-10-06T00:00:00Z')
    expect(n).toBe(250)
    expect(calls.map((c) => (c.body as unknown[]).length)).toEqual([200, 50])
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toContain('on_conflict=pipedream_hashid')
    expect(calls[0].headers['content-profile']).toBe('porting')
    expect(calls[0].headers.prefer).toContain('resolution=merge-duplicates')
    expect(calls[0].headers.prefer).toContain('return=representation')
    const sent = (calls[0].body as Array<Record<string, unknown>>)[0]
    expect('porting_stage' in sent).toBe(false)
    expect(sent.updated_at).toBe('2026-10-06T00:00:00Z')
  })

  it('refuses when the database reports fewer rows than were sent (L12)', async () => {
    const { f } = fakeFetch(() => Response.json([]))
    await expect(writeRows(f, URL_, KEY, [row('p_1')], 'now')).rejects.toThrow(/1 sent.*0 written/)
  })

  it('throws with the status when a batch fails, naming how many earlier batches were written', async () => {
    let n = 0
    const { f } = fakeFetch((c) => (n++ === 0 ? Response.json((c.body as unknown[]).map(() => ({}))) : new Response('boom', { status: 500 })))
    await expect(writeRows(f, URL_, KEY, Array.from({ length: 201 }, (_, i) => row(`p_${i}`)), 'now')).rejects.toThrow(/500.*boom.*200 row\(s\) already written/)
  })

  it('writes nothing and calls nothing for an empty list', async () => {
    const { f, calls } = fakeFetch(() => Response.json([]))
    expect(await writeRows(f, URL_, KEY, [], 'now')).toBe(0)
    expect(calls).toHaveLength(0)
  })
})

describe('differencesAfterWrite (#1710)', () => {
  it('finds nothing when every planned row is stored as planned, a timestamp in another spelling included', () => {
    const planned = { ...row('p_1'), first_seen_export_at: '2026-09-30T19:26:13Z', last_seen_export_at: '2026-09-30T19:26:13Z' }
    const stored = { ...planned, first_seen_export_at: '2026-09-30T19:26:13+00:00', last_seen_export_at: '2026-09-30T19:26:13+00:00' }
    expect(differencesAfterWrite([planned], [stored])).toEqual([])
  })

  it('names a missing row and each column stored differently', () => {
    const planned = [row('p_1'), row('p_2')]
    const stored = [{ ...row('p_1'), pipedream_state: 'off' as const, trigger_types: ['timer'] }]
    expect(differencesAfterWrite(planned, stored)).toEqual([
      'p_1.pipedream_state: planned "on", stored "off"',
      'p_1.trigger_types: planned [], stored ["timer"]',
      'p_2 missing',
    ])
  })
})
