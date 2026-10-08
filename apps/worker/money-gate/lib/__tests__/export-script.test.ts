/**
 * The output guard for the fixture shape export (#1704, L222).
 *
 * The export is the one money gate component that reads production lead data.
 * This drives its whole pipeline (reads, files written, lines printed) over
 * payloads whose every value is a recognisable token, and fails if any token
 * reaches a file or the console. It must pass before the script is ever run
 * against production.
 */
import { describe, it, expect } from 'vitest'
import { runExport, makeExportClient, type ExportDeps } from '../../../scripts/export-money-fixture-shapes'
import { scanForPersonalData } from '../fixture-scan'

const WF = 'da82a183-1a4a-417e-b0b8-5f3fe5e14840'
const ORG = '00000000-0000-4000-8000-0000000000aa'

function lead(i: number) {
  return {
    leadUuid: `5ec7e7a1-0000-4000-8000-${String(700000000000 + i)}`,
    personalInformation: {
      firstName: `Ottoline${i}`, lastName: 'Brackenridge', email: `obr${i}@mailhost.org`,
      ssn: `4${String(10 + i).padStart(2, '0')}-55-${String(2000 + i)}`, dateOfBirth: '1979-11-23',
      phone: '3055550142', state: i % 2 ? 'FL' : 'GA', address: '88 Larkspur Way',
    },
    financialInformation: { creditScore: 655 + i, annualIncome: 91234 + i },
    loanInformation: { loanAmount: 18765 + i, purpose: 'debt_consolidation' },
  }
}
const PAYLOADS = Array.from({ length: 12 }, (_, i) => lead(i))

// Production copy carries typographic dashes; written as \u escapes the file stays ASCII.
const DEFINITION = { trigger: { type: 'http_webhook', config: {} }, nodes: [{ id: 'n1', namespace: 'a', type: 'code', config: { script: 'return 1 // borrow \u2014 fast \u{1F4B0}' } }], edges: [] }

function fakeTables(): Record<string, Array<Record<string, unknown>>> {
  return {
    workflows: [{ id: WF, name: 'Engine Bidding Workflow', organization_id: ORG, is_active: true, deleted_at: null, lane: 'money', slack_channel: null, definition: DEFINITION }],
    workflow_executions: PAYLOADS.map((p) => ({ workflow_id: WF, trigger_payload: p, source: 'engine', is_test: false, started_at: '2026-09-30T12:00:00Z' })),
    partner_configs: [{ id: 'p1', slug: 'tripoint', organization_id: ORG, daily_cap: 4321, bid_resolver_config: { tiers: [{ above: 12499, multiplier: 0.0013 }] }, updated_by_email: 'editor@trypennie.com' }],
    buyer_profiles: [{ partner_id: 'p1', organization_id: ORG, allowed_states: ['FL'], debt_min: 7777, updated_by_email: 'editor@trypennie.com' }],
    partner_uuid_map: [{ id: 'u1', org_id: ORG, partner_slug: 'sofi', uuid: 'c0ffee00-aaaa-4bbb-8ccc-0123456789ab' }],
    environment_variables: [{ key: 'EQUIFAX_PASSWORD', value: 'Sup3rS3cretValue!', is_secret: true, scope: 'global', organization_id: ORG, workflow_id: null }],
    workflow_versions: [{ id: 'v1', workflow_id: WF, version_number: 7 }],
    buyer_pricing_tiers: [{ id: 't1', organization_id: ORG, partner_id: 'p1', population: 'engine', debt_from: 12345, debt_to: null, multiplier: 0.0137 }],
    buyer_operating_windows: [{ id: 'w1', organization_id: ORG, partner_id: 'p1', day_of_week: 3, opens_minute: 540, closes_minute: 1020, updated_by_email: 'hours.editor@trypennie.com' }],
    buyer_blackout_dates: [{ id: 'b1', organization_id: ORG, partner_id: 'p1', blackout_date: '2026-12-25', note: 'Priya out, see thread', reason: 'holiday call with Dana', created_by: 'u9' }],
  }
}

// A minimal PostgREST-like reader over the tables above: enough for the export's reads.
function fakeClient(tables = fakeTables()) {
  const reads: string[] = []
  return {
    reads,
    client: {
      from(table: string) {
        reads.push(table)
        let rows = [...(tables[table] ?? [])]
        const b: Record<string, unknown> = {}
        const chain = (fn: (r: Record<string, unknown>[]) => Record<string, unknown>[]) => { rows = fn(rows); return b }
        b.select = () => b
        b.eq = (c: string, v: unknown) => chain((r) => r.filter((x) => x[c] === v))
        b.is = (c: string, v: unknown) => chain((r) => r.filter((x) => (x[c] ?? null) === v))
        b.gte = () => b
        b.order = () => b
        b.limit = (n: number) => chain((r) => r.slice(0, n))
        b.insert = () => { throw new Error('insert reached the fake client') }
        b.then = (res: (v: unknown) => void) => res({ data: rows, error: null })
        return b
      },
    },
  }
}

async function run() {
  const files = new Map<string, string>()
  const lines: string[] = []
  const { client, reads } = fakeClient()
  const deps: ExportDeps = {
    client: client as never,
    fetchBackupDefinition: async () => DEFINITION,
    write: (path, text) => files.set(path, text),
    log: (line) => lines.push(line),
    now: () => new Date('2026-10-01T00:00:00Z'),
  }
  await runExport(deps)
  return { files, lines, reads }
}

function leafStrings(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => leafStrings(x, out))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => leafStrings(x, out))
  else if (v !== null && v !== undefined) out.push(String(v))
  return out
}

describe('export-money-fixture-shapes output guard', () => {
  it('writes the shapes, the config snapshot and each live definition', async () => {
    const { files } = await run()
    expect([...files.keys()].sort()).toEqual([
      'money-gate/fixtures/config-snapshot.json',
      `money-gate/fixtures/definitions/${WF}.json`,
      'money-gate/fixtures/shapes.json',
    ])
  })

  it('no payload value reaches any file or any printed line, except an enumerated domain', async () => {
    const { files, lines } = await run()
    const everything = [...files.values(), ...lines].join('\n')
    const allowed = new Set(['FL', 'GA', 'debt_consolidation'])
    const leaked = [...new Set(PAYLOADS.flatMap((p) => leafStrings(p)))]
      .filter((v) => !allowed.has(v) && v.length >= 3)
      .filter((v) => everything.includes(v))
    expect(leaked).toEqual([])
  })

  it('no secret value, real price or editor reaches the snapshot', async () => {
    const { files } = await run()
    const snap = files.get('money-gate/fixtures/config-snapshot.json')!
    for (const v of ['Sup3rS3cretValue!', '4321', '12499', '0.0013', '7777', 'editor@trypennie.com']) expect(snap).not.toContain(v)
    expect(snap).toContain('placeholder-EQUIFAX_PASSWORD')
  })

  it('synthesizes buyer prices and keeps buyer operating hours, which are structure', async () => {
    const { files } = await run()
    const snap = JSON.parse(files.get('money-gate/fixtures/config-snapshot.json')!) as { tables: Record<string, Array<Record<string, unknown>>> }
    expect(snap.tables.buyer_pricing_tiers[0]).toMatchObject({ population: 'engine', debt_from: 10000, multiplier: 0.01 })
    expect(snap.tables.buyer_operating_windows[0]).toMatchObject({ day_of_week: 3, opens_minute: 540, closes_minute: 1020 })
    expect(snap.tables.buyer_blackout_dates).toEqual([{ id: 'b1', organization_id: ORG, partner_id: 'p1', blackout_date: '2026-12-25' }])
  })

  it('never commits a column no table lists: an editor, a note or a reason', async () => {
    const { files } = await run()
    const snap = files.get('money-gate/fixtures/config-snapshot.json')!
    for (const v of ['hours.editor@trypennie.com', 'Priya out', 'holiday call', 'updated_by_email', '"note"', '"reason"', '"created_by"']) expect(snap).not.toContain(v)
  })

  it('everything written passes the personal data scanner', async () => {
    const { files } = await run()
    for (const [path, text] of files) expect({ path, findings: scanForPersonalData(JSON.parse(text)) }).toEqual({ path, findings: [] })
  })

  it('writes ASCII only, escaping any other character so the parsed content is unchanged', async () => {
    const { files } = await run()
    for (const [path, text] of files) expect({ path, nonAscii: [...text].some((c) => c.charCodeAt(0) > 0x7f) }).toEqual({ path, nonAscii: false })
    const def = JSON.parse(files.get(`money-gate/fixtures/definitions/${WF}.json`)!) as { definition: unknown }
    expect(def.definition).toEqual(DEFINITION)
  })

  it('prints counts and names only', async () => {
    const { lines } = await run()
    expect(lines.join('\n')).toMatch(/Engine Bidding Workflow: 12 samples/)
  })
})

describe('export-money-fixture-shapes writes all or nothing', () => {
  it('writes no file at all when a later workflow\'s backup differs from production', async () => {
    const WF2 = 'ffffffff-0000-4000-8000-000000000002'
    const tables = fakeTables()
    // Sorted after WF, so a writer inside the check loop would already have written WF's file.
    tables.workflows.push({ id: WF2, name: 'Second', organization_id: ORG, is_active: true, deleted_at: null, lane: 'money', slack_channel: null, definition: DEFINITION })
    tables.workflow_executions.push(...PAYLOADS.map((p) => ({ workflow_id: WF2, trigger_payload: p, source: 'engine', is_test: false, started_at: '2026-09-30T12:00:00Z' })))
    const files = new Map<string, string>()
    const { client } = fakeClient(tables)
    await expect(runExport({
      client: client as never,
      fetchBackupDefinition: async (id) => (id === WF2 ? { ...DEFINITION, nodes: [] } : DEFINITION),
      write: (path, text) => files.set(path, text),
      log: () => {},
      now: () => new Date('2026-10-01T00:00:00Z'),
    })).rejects.toThrow(/backup of Second differs/)
    expect([...files.keys()]).toEqual([])
  })
})

// #1707: the gate replays the bidding Worker, so an ops workflow is never one of
// its fixtures, and every exported workflow row carries the money lane the head
// engine refuses to run without.
describe('export-money-fixture-shapes exports money workflows only', () => {
  it('leaves an ops workflow out and stamps each exported row with the money lane', async () => {
    const OPS = 'ffffffff-0000-4000-8000-000000000003'
    const tables = fakeTables()
    tables.workflows.push({ id: OPS, name: 'Ops tool', organization_id: ORG, is_active: true, deleted_at: null, lane: 'ops', slack_channel: null, definition: DEFINITION })
    const files = new Map<string, string>()
    const { client } = fakeClient(tables)
    await runExport({
      client: client as never,
      fetchBackupDefinition: async () => DEFINITION,
      write: (path, text) => files.set(path, text),
      log: () => {},
      now: () => new Date('2026-10-01T00:00:00Z'),
    })
    const snapshot = JSON.parse(files.get('money-gate/fixtures/config-snapshot.json') ?? '{}') as { tables: { workflows: { id: string; lane: string }[] } }
    expect(snapshot.tables.workflows.map((w) => [w.id, w.lane])).toEqual([[WF, 'money']])
    expect([...files.keys()].some((k) => k.includes(OPS))).toBe(false)
  })
})

describe('makeExportClient', () => {
  it('builds a client that refuses writes and rpc', () => {
    const c = makeExportClient('https://example.supabase.co', 'not-a-real-key') as unknown as {
      from: (t: string) => { insert: (r: unknown) => unknown; select: () => { update: (r: unknown) => unknown } }
      rpc: (n: string) => unknown
    }
    expect(() => c.from('workflows').insert({})).toThrow(/read only/)
    expect(() => c.from('workflows').select().update({})).toThrow(/read only/)
    expect(() => c.rpc('anything')).toThrow(/read only/)
  })
})
