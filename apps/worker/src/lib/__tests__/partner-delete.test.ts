/**
 * The partner delete check (#2140): blockers, the consequence, the workflows a
 * delete would leave without the partner, and the fingerprint, from their parts.
 */
import { describe, it, expect } from 'vitest'
import labels from '../../partner-delete/labels/dependents.json'
import {
  blockersSentence,
  buildDeleteCheck,
  dependentNoun,
  parseCheckAnswer,
  parseFingerprint,
  runDeleteCheck,
  PartnerNotFoundError,
  type CheckAnswer,
  type CheckDependent,
} from '../partner-delete'
import type { OrgWorkflow } from '../org-workflows'

const PARTNER = { id: 'p-tp', name: 'Tripoint', slug: 'tripoint', partner_type: 'buyer', is_active: true }
const ZERO = { unmirrored: 0, unresolved: 0 }
const NONE = new Map<string, Set<string>>()

/** Every dependent the SQL check answers today, with these counts. */
function dependents(rows: Partial<Record<string, number>> = {}, blocking: Partial<Record<string, number>> = {}): CheckDependent[] {
  return Object.keys(labels.tables).map((table) => {
    const kind = table === 'buyer_sales' || table === 'held_click_claims' ? 'blocks' : 'deleted'
    return { table, kind, rows: rows[table] ?? blocking[table] ?? 0, blocking_rows: blocking[table] ?? 0 }
  })
}
const check = (deps: CheckDependent[] = dependents(), secret: CheckAnswer['secret'] = null): CheckAnswer => ({ partner: PARTNER, dependents: deps, secret })

const constantsNode = { id: 'n-const', namespace: 'constants', type: 'constants', config: { data: {} } }
const code = (script: string) => ({ id: 'n-code', namespace: 'reader', label: 'reader', type: 'code', config: { script } })
const wf = (id: string, nodes: unknown[], over: Partial<OrgWorkflow> = {}): OrgWorkflow => ({
  id,
  name: `Workflow ${id}`,
  is_active: true,
  definition: { nodes, edges: [] },
  updated_at: `2026-10-15T12:00:00.00000${id.length}+00:00`,
  ...over,
})

describe('dependentNoun', () => {
  it('labels every table in the labels file, and fails loudly on a table with none', () => {
    expect(dependentNoun('partner_uuid_map')).toEqual({ one: 'sub-account ID', many: 'sub-account IDs' })
    expect(() => dependentNoun('a_new_child_table')).toThrow(/no label for the dependent table a_new_child_table/)
  })

  it('a dependent the SQL check answers with no label fails the whole check, rows or not', () => {
    const deps = [...dependents(), { table: 'a_new_child_table', kind: 'deleted' as const, rows: 0, blocking_rows: 0 }]
    expect(() => buildDeleteCheck(check(deps), [], [], NONE, ZERO)).toThrow(/a_new_child_table/)
  })
})

describe('buildDeleteCheck', () => {
  it('no blockers: the consequence lists only the tables with rows, sub-account IDs and matrix history included', () => {
    const got = buildDeleteCheck(check(dependents({ buyer_profiles: 1, partner_uuid_map: 2, bid_config_history: 4, bid_matrix_rows: 0 })), [], ['u1', 'u2'], NONE, ZERO)
    expect(got.blockers).toEqual([])
    // In the order the SQL check answers (the labels file's order here).
    expect(got.removes.map((r) => [r.table, r.rows, r.noun.many])).toEqual([
      ['buyer_profiles', 1, 'buyer profiles'],
      ['bid_config_history', 4, 'matrix history entries'],
      ['partner_uuid_map', 2, 'sub-account IDs'],
    ])
  })

  it('rows a restrict key holds are blockers with their count; a blocking table with none is not', () => {
    const got = buildDeleteCheck(check(dependents({}, { buyer_sales: 6323 })), [], [], NONE, ZERO)
    expect(got.blockers).toEqual([{ kind: 'rows', table: 'buyer_sales', rows: 6323, noun: { one: 'sale', many: 'sales' } }])
    expect(blockersSentence('Tripoint', got.blockers)).toBe('Tripoint cannot be deleted: 6,323 sales refer to it.')
  })

  it('a buyer with one unmirrored ledger entry and no buyer_sales row is blocked (L38, B1)', () => {
    const got = buildDeleteCheck(check(), [], [], NONE, { unmirrored: 1, unresolved: 0 })
    expect(got.blockers).toEqual([{ kind: 'ledger_unmirrored', count: 1 }])
    expect(blockersSentence('Tripoint', got.blockers)).toBe('Tripoint cannot be deleted: 1 sale is not yet recorded.')
    const both = buildDeleteCheck(check(), [], [], NONE, { unmirrored: 2, unresolved: 3 })
    expect(blockersSentence('Tripoint', both.blockers)).toBe('Tripoint cannot be deleted: 2 sales are not yet recorded, 3 sales are awaiting settlement.')
  })

  it('a workflow reading constants.<Slug>SellOffOfferTitle and naming no partner id is listed as reading it by name', () => {
    const reader = wf('w-reader', [constantsNode, code('return { title: constants.TripointSellOffOfferTitle }')])
    const other = wf('w-other', [constantsNode, code('return 1')])
    const got = buildDeleteCheck(check(), [reader, other], [], NONE, ZERO)
    expect(got.workflows_naming_partner).toEqual([])
    expect(got.workflows_reading_values).toEqual([{ id: 'w-reader', name: 'Workflow w-reader', is_active: true, reads: 'by_name', values: ['TripointSellOffOfferTitle'] }])
  })

  it('a workflow reading the whole activeBidding map reads it for every partner, worded apart from one naming the partner', () => {
    const every = wf('w-every', [constantsNode, code('const on = constants.activeBidding[sourceName]')], { is_active: false })
    const got = buildDeleteCheck(check(), [every], [], NONE, ZERO)
    expect(got.workflows_reading_values).toEqual([{ id: 'w-every', name: 'Workflow w-every', is_active: false, reads: 'every_partner', values: ['activeBidding'] }])
  })

  it('workflows naming the partner by id: a bid group, a click node, and a buyer_select priced for it', () => {
    const bidGroup = wf('w-bg', [{ type: 'bid_group', config: { partner_ids: ['p-tp'] } }])
    const click = wf('w-click', [{ type: 'buyer_click_send', config: { partner_id: 'p-tp' } }], { is_active: false })
    const select = wf('w-select', [{ type: 'buyer_select', config: { population: 'engine' } }])
    const unrelated = wf('w-x', [{ type: 'bid_group', config: { partner_ids: ['p-other'] } }])
    const priced = new Map([['engine', new Set(['p-tp'])]])
    const got = buildDeleteCheck(check(), [bidGroup, click, select, unrelated], [], priced, ZERO)
    expect(got.workflows_naming_partner).toEqual([
      { id: 'w-bg', name: 'Workflow w-bg', is_active: true },
      { id: 'w-click', name: 'Workflow w-click', is_active: false },
      { id: 'w-select', name: 'Workflow w-select', is_active: true },
    ])
  })

  it('the fingerprint is every dependent count, zeros included, and every workflow scanned with its updated_at as read', () => {
    const w = [wf('a', []), wf('bb', [])]
    const got = buildDeleteCheck(check(dependents({ partner_uuid_map: 2 })), w, [], NONE, ZERO)
    expect(got.fingerprint.counts).toEqual({ ...Object.fromEntries(Object.keys(labels.tables).map((t) => [t, 0])), partner_uuid_map: 2 })
    expect(got.fingerprint.workflows).toEqual([{ id: 'a', updated_at: '2026-10-15T12:00:00.000001+00:00' }, { id: 'bb', updated_at: '2026-10-15T12:00:00.000002+00:00' }])
  })

  it('says what the secret is and how many other partners name it', () => {
    expect(buildDeleteCheck(check(dependents(), { name: 'TRIPOINT_PROXY_SECRET', other_partners: 0 }), [], [], NONE, ZERO).secret).toEqual({ name: 'TRIPOINT_PROXY_SECRET', other_partners: 0 })
  })
})

describe('runDeleteCheck', () => {
  const sources = (over: Partial<Parameters<typeof runDeleteCheck>[0]> = {}) => ({
    check: async () => ({ partner: PARTNER, dependents: dependents(), secret: null }) as unknown,
    subAccountIds: async () => [],
    workflows: async () => [wf('a', [])],
    pricedPartners: async () => NONE,
    ledger: async () => ZERO,
    ...over,
  })

  it('fails as a whole when any part fails, never answering a partial check (L530)', async () => {
    for (const part of ['subAccountIds', 'workflows', 'pricedPartners', 'ledger'] as const) {
      await expect(runDeleteCheck(sources({ [part]: async () => { throw new Error(`${part} down`) } })), part).rejects.toThrow(`${part} down`)
    }
    await expect(runDeleteCheck(sources({ check: async () => ({ partner: PARTNER }) }))).rejects.toThrow(/unexpected shape/)
  })

  it('reads nothing else for a partner the SQL check did not find in the organization', async () => {
    let read = false
    const s = sources({ check: async () => { throw new PartnerNotFoundError('p-x') }, ledger: async () => { read = true; return ZERO }, workflows: async () => { read = true; return [] } })
    await expect(runDeleteCheck(s)).rejects.toBeInstanceOf(PartnerNotFoundError)
    expect(read).toBe(false)
  })
})

describe('parseCheckAnswer and parseFingerprint', () => {
  it('reads the RPC answer and refuses any other shape', () => {
    expect(parseCheckAnswer({ partner: PARTNER, dependents: [{ table: 'buyer_sales', kind: 'blocks', rows: 1, blocking_rows: 1 }], secret: null }).dependents).toHaveLength(1)
    expect(() => parseCheckAnswer({ partner: PARTNER, dependents: [{ table: 'buyer_sales', kind: 'gone', rows: 1, blocking_rows: 1 }] })).toThrow()
    expect(() => parseCheckAnswer(null)).toThrow()
  })

  it('takes a fingerprint as the check sent it, and nothing else', () => {
    const fp = { counts: { partner_uuid_map: 2 }, workflows: [{ id: 'a', updated_at: '2026-10-15T12:00:00.123456+00:00' }] }
    expect(parseFingerprint(fp)).toEqual(fp)
    expect(parseFingerprint(undefined)).toBeNull()
    expect(parseFingerprint({ counts: { x: -1 }, workflows: [] })).toBeNull()
    expect(parseFingerprint({ counts: {}, workflows: [{ id: 'a' }] })).toBeNull()
  })
})
