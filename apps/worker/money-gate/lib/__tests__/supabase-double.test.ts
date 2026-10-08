import { describe, it, expect } from 'vitest'
import { createSupabaseDouble } from '../supabase-double'

const tables = () => ({
  workflows: [{ id: 'w1', name: 'Engine', organization_id: 'o1', is_active: true, deleted_at: null, definition: { nodes: [] } }],
  workflow_versions: [{ id: 'v1', workflow_id: 'w1', version_number: 3 }, { id: 'v0', workflow_id: 'w1', version_number: 2 }],
  partner_configs: [
    { id: 'p1', slug: 'tripoint', organization_id: 'o1', priority: 2, is_active: true },
    { id: 'p2', slug: 'amone', organization_id: 'o1', priority: 1, is_active: true },
    { id: 'p3', slug: 'gone', organization_id: 'o1', priority: 3, is_active: false },
  ],
})

describe('createSupabaseDouble reads', () => {
  it('filters, orders and limits', async () => {
    const { client } = createSupabaseDouble(tables())
    const { data, error } = await client.from('partner_configs').select('slug').eq('organization_id', 'o1').eq('is_active', true).order('priority', { ascending: true })
    expect(error).toBeNull()
    expect((data as Array<{ slug: string }>).map((r) => r.slug)).toEqual(['amone', 'tripoint'])
  })

  it('supports in, is, neq, gte and single', async () => {
    const { client } = createSupabaseDouble(tables())
    expect((await client.from('partner_configs').select('*').in('slug', ['amone', 'gone'])).data).toHaveLength(2)
    expect((await client.from('workflows').select('*').is('deleted_at', null)).data).toHaveLength(1)
    expect((await client.from('partner_configs').select('*').neq('slug', 'amone').gte('priority', 3)).data).toHaveLength(1)
    const one = await client.from('partner_configs').select('*').eq('slug', 'tripoint').single()
    expect((one.data as { id: string }).id).toBe('p1')
  })

  it('single on no rows answers the PostgREST not found error', async () => {
    const { client } = createSupabaseDouble(tables())
    const r = await client.from('partner_configs').select('*').eq('slug', 'nope').single()
    expect(r.data).toBeNull()
    expect(r.error?.code).toBe('PGRST116')
    expect((await client.from('partner_configs').select('*').eq('slug', 'nope').maybeSingle()).data).toBeNull()
  })

  it('embeds a child table named in the select, newest first when ordered', async () => {
    const { client } = createSupabaseDouble(tables())
    const r = await client.from('workflows').select('id, workflow_versions (id, version_number)').eq('id', 'w1')
      .order('version_number', { referencedTable: 'workflow_versions', ascending: false })
      .limit(1, { referencedTable: 'workflow_versions' }).single()
    expect((r.data as { workflow_versions: Array<{ id: string }> }).workflow_versions).toEqual([{ id: 'v1', workflow_id: 'w1', version_number: 3 }])
  })

  it('embeds a many to one parent as an object and filters on !inner', async () => {
    const d = createSupabaseDouble({
      ...tables(),
      buyer_profiles: [{ partner_id: 'p1', organization_id: 'o1', is_enabled: true }, { partner_id: 'missing', organization_id: 'o1', is_enabled: true }],
      buyer_pricing_tiers: [{ partner_id: 'p1', population: 'engine', multiplier: 0.01 }],
    })
    const r = await d.client.from('buyer_profiles').select('partner_id, partner_configs!inner(id, slug), buyer_pricing_tiers(population, multiplier)').eq('organization_id', 'o1')
    const rows = r.data as Array<{ partner_id: string; partner_configs: { slug: string }; buyer_pricing_tiers: unknown[] }>
    expect(rows).toHaveLength(1)
    expect(rows[0].partner_configs.slug).toBe('tripoint')
    expect(rows[0].buyer_pricing_tiers).toEqual([{ partner_id: 'p1', population: 'engine', multiplier: 0.01 }])
    expect(d.unsupportedFilters()).toEqual([])
  })

  it('records an embed it has no relation for', async () => {
    const d = createSupabaseDouble(tables())
    await d.client.from('partner_configs').select('slug, mystery_children (id)')
    expect(d.unsupportedFilters()).toEqual(['partner_configs embeds mystery_children with no declared relation'])
  })

  it('answers an unknown table with no rows and records the read', async () => {
    const d = createSupabaseDouble(tables())
    expect((await d.client.from('nothing_here').select('*')).data).toEqual([])
    expect(d.unknownTables()).toEqual(['nothing_here'])
  })
})

describe('createSupabaseDouble writes', () => {
  it('records every write in order and applies it to the in-memory store only', async () => {
    const t = tables()
    const d = createSupabaseDouble(t)
    await d.client.from('execution_steps').insert([{ id: 's1', step_namespace: 'a' }])
    const upd = await d.client.from('partner_configs').update({ priority: 9 }).eq('slug', 'amone').select('id')
    await d.client.from('partner_configs').delete().eq('slug', 'gone')
    await d.client.rpc('record_held_click', { p: 1 })
    expect(upd.data).toEqual([{ id: 'p2', slug: 'amone', organization_id: 'o1', priority: 9, is_active: true }])
    expect(d.writes().map((w) => `${w.op} ${w.table}`)).toEqual(['insert execution_steps', 'update partner_configs', 'delete partner_configs', 'rpc record_held_click'])
    expect(d.writes()[1].filters).toEqual([['eq', 'slug', 'amone']])
    expect((await d.client.from('execution_steps').select('*')).data).toHaveLength(1)
    expect(t.partner_configs.find((r) => r.slug === 'amone')?.priority).toBe(1)
  })

  it('an update matching nothing returns no rows, as PostgREST does', async () => {
    const d = createSupabaseDouble(tables())
    const r = await d.client.from('workflow_executions').update({ status: 'x' }).eq('id', 'missing').select('id')
    expect(r.data).toEqual([])
    expect(r.error).toBeNull()
  })

  it('upsert updates on the conflict columns and inserts otherwise', async () => {
    const d = createSupabaseDouble(tables())
    await d.client.from('partner_configs').upsert([{ slug: 'amone', organization_id: 'o1', priority: 5 }, { slug: 'new', organization_id: 'o1', priority: 7 }], { onConflict: 'organization_id,slug' })
    const rows = (await d.client.from('partner_configs').select('*').order('slug')).data as Array<{ slug: string; priority: number }>
    expect(rows.map((r) => `${r.slug}:${r.priority}`)).toEqual(['amone:5', 'gone:3', 'new:7', 'tripoint:2'])
  })

  it('an upsert with ignoreDuplicates returns no row for a duplicate it ignored, as PostgREST does', async () => {
    const d = createSupabaseDouble(tables())
    const r = await d.client.from('partner_configs')
      .upsert([{ slug: 'amone', organization_id: 'o1', priority: 5 }, { slug: 'fresh', organization_id: 'o1', priority: 6 }], { onConflict: 'organization_id,slug', ignoreDuplicates: true })
      .select('slug')
    expect((r.data as Array<{ slug: string }>).map((x) => x.slug)).toEqual(['fresh'])
    const amone = (await d.client.from('partner_configs').select('*').eq('slug', 'amone').single()).data as { priority: number }
    expect(amone.priority).toBe(1)
  })

  it('a reader cannot mutate the store through a returned row', async () => {
    const d = createSupabaseDouble(tables())
    const r = await d.client.from('partner_configs').select('*').eq('slug', 'amone').single()
    ;(r.data as { priority: number }).priority = 100
    expect(((await d.client.from('partner_configs').select('*').eq('slug', 'amone').single()).data as { priority: number }).priority).toBe(1)
  })
})

describe('createSupabaseDouble read delay (#1872)', () => {
  /** A delay the test releases by hand, so nothing here waits on real time. */
  function gate() {
    const waiting: Array<() => void> = []
    return { delayRead: () => new Promise<void>((resolve) => { waiting.push(resolve) }), release: () => waiting.splice(0).forEach((r) => r()), pending: () => waiting.length }
  }

  it('holds every read until its delay ends, then answers it as usual', async () => {
    const g = gate()
    const d = createSupabaseDouble(tables(), { delayRead: g.delayRead })
    let answered = false
    const read = d.client.from('partner_configs').select('slug').eq('slug', 'amone').single().then((r: { data: unknown }) => { answered = true; return r })
    await Promise.resolve()
    await Promise.resolve()
    expect(g.pending()).toBe(1)
    expect(answered).toBe(false)
    g.release()
    expect((await read).data).toMatchObject({ slug: 'amone' })
  })

  it('never holds a write, so the recorded order of writes is the engine order', async () => {
    const g = gate()
    const d = createSupabaseDouble(tables(), { delayRead: g.delayRead })
    await d.client.from('workflow_versions').insert({ id: 'v9', workflow_id: 'w1', version_number: 9 })
    await d.client.from('partner_configs').update({ priority: 5 }).eq('slug', 'amone')
    expect(g.pending()).toBe(0)
    expect(d.writes().map((w) => w.op)).toEqual(['insert', 'update'])
  })
})

describe('createSupabaseDouble compares values, never their text (#1862)', () => {
  it('an in filter does not match one object against another because both print as [object Object]', async () => {
    const d = createSupabaseDouble({ events: [{ id: 'e1', meta: { a: 1 } }, { id: 'e2', meta: { b: 2 } }] })
    const { data } = await d.client.from('events').select('id').in('meta', [{ c: 3 }])
    expect(data).toEqual([])
  })

  it('an in filter still matches a number against the same number sent as text, as PostgREST does', async () => {
    const d = createSupabaseDouble({ events: [{ id: 1 }, { id: 2 }] })
    const { data } = await d.client.from('events').select('id').in('id', ['2'])
    expect((data as Array<{ id: number }>).map((r) => r.id)).toEqual([2])
  })

  it('an upsert names its conflict columns only from a string, never from the text of an object', async () => {
    const d = createSupabaseDouble({ events: [{ id: 'e1', n: 1 }] })
    await d.client.from('events').upsert({ id: 'e1', n: 2 }, { onConflict: { not: 'a string' } as unknown as string })
    // Falls back to the id column, so the existing row is updated rather than a column named [object Object] matched.
    const { data } = await d.client.from('events').select('*')
    expect(data).toEqual([{ id: 'e1', n: 2 }])
  })
})
