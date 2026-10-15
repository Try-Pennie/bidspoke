/**
 * GET /partners/:id/history (#2141, PR10 of #2114): the partners page History.
 *
 * Who may call: any allowlisted member of the organization (jwtAuth). Whose
 * rows: one partner of the caller's organization; every read but the editor
 * names carries orgId or ids read under it.
 *
 * It merges audit_log (partner settings, the buyer profile, the bid matrix
 * configs, sub-account IDs, held clicks) with bid_config_history (the matrix
 * syncs), newest first, and names who made each change. Every read is all or
 * nothing: any one failing answers an error naming that read, never a shorter
 * list and never an unnamed editor (L530, L215, L11).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { makeSupabase, type TableConfig } from './_supabase-mock'
import type { PartnerHistory } from '@bidspoke/partner-history'

const ORG = 'org-abc'
const PARTNER = '33333333-3333-3333-3333-333333332141'
const CONFIG = '44444444-4444-4444-4444-444444442141'
const testUser = { id: 'user-1', organization_id: ORG, email: 'dan@pennie.com', display_name: 'Dan Wright' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function wire(tables: Record<string, TableConfig | TableConfig[]>) {
  const supabase = makeSupabase({ partner_configs: { single: { id: PARTNER } }, ...tables, users: { single: testUser, ...(tables.users as TableConfig | undefined) } })
  vi.mocked(createSupabaseClient).mockReturnValue(supabase as unknown as ReturnType<typeof createSupabaseClient>)
  return supabase
}

// Erin edited settings; her users row was later moved to another organization
// and its display name cleared, so she resolves to her address.
const ERIN = { id: 'user-erin', display_name: null, email: 'erin@example.test' }
const DAN = { id: 'user-1', display_name: 'Dan Wright', email: 'dan@pennie.com' }

const AUDIT = [
  { id: 'a1', changed_at: '2026-10-15T16:00:00+00:00', changed_by: 'user-erin', entity_type: 'partner_config', entity_id: PARTNER, action: 'updated',
    changes: { daily_cap: { old: 40, new: 50 }, _actor: { name: 'Erin Old Name', email: 'erin@example.test' } } },
  { id: 'a2', changed_at: '2026-10-15T15:00:00+00:00', changed_by: null, entity_type: 'buyer_profile', entity_id: PARTNER, action: 'updated',
    changes: { _source: 'direct_sql', table: 'buyer_pricing_tiers', op: 'UPDATE', rows: 2 } },
  { id: 'a3', changed_at: '2026-10-14T20:00:00+00:00', changed_by: null, entity_type: 'partner_config', entity_id: PARTNER, action: 'updated',
    changes: { name: { old: 'A', new: 'B' }, _actor: { name: 'Stamped Sam', email: 'sam@example.test' } } },
  { id: 'a4', changed_at: '2026-10-14T19:00:00+00:00', changed_by: null, entity_type: 'partner_uuid', entity_id: 'pu-1', action: 'created',
    changes: { uuid: { old: null, new: 'u-1' }, partner_id: PARTNER, _source: 'job', _job: 'nightly_import' } },
  { id: 'a5', changed_at: '2026-10-13T12:00:00+00:00', changed_by: 'user-1', entity_type: 'held_click', entity_id: 'hc-1', action: 'updated',
    changes: { claim_state: { old: 'held', new: 'sold' }, subject: { partner_id: PARTNER } } },
]
const MATRIX = [
  { id: 'm1', changed_at: '2026-10-15T15:30:00+00:00', changed_by: 'user-1', config_id: CONFIG, source: 'salesforce_sync', diff: { rows_fetched: 3 } },
  { id: 'm2', changed_at: '2026-10-14T21:00:00+00:00', changed_by: null, config_id: CONFIG, source: 'salesforce_sync', diff: { rows_fetched: 2 } },
]

describe('GET /partners/:id/history (#2141)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  const get = (id = PARTNER) => app.request(`/partners/${id}/history`, { headers: { Authorization: 'Bearer tok' } }, testEnv, mockCtx)

  it('merges both sources newest first and names every editor, people, jobs and direct edits', async () => {
    const supabase = wire({
      partner_bid_configs: { list: [{ id: CONFIG, name: 'SoFi default' }] },
      audit_log: { list: AUDIT },
      bid_config_history: { list: MATRIX },
      users: { list: [ERIN, DAN] },
    })
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json() as PartnerHistory
    expect(body.partnerId).toBe(PARTNER)
    expect(body.complete).toBe(true)
    expect(body.completeSince).toBeNull()
    expect(body.entries.map((e) => [e.key, e.editorLabel])).toEqual([
      // A users row wins over the stamped name, and a cleared name falls back to the address.
      ['audit:a1', 'erin@example.test'],
      ['matrix:m1', 'Dan Wright, Sync now from Salesforce'],
      ['audit:a2', 'Changed directly in the database'],
      ['matrix:m2', 'Bidspoke, hourly Salesforce matrix sync'],
      // No changed_by, a stamped _actor: the stamped name.
      ['audit:a3', 'Stamped Sam'],
      ['audit:a4', 'Bidspoke job nightly_import'],
      ['audit:a5', 'Dan Wright'],
    ])
    expect(body.entries[0]).toMatchObject({
      source: 'audit_log', at: '2026-10-15T16:00:00+00:00', entityType: 'partner_config', entityId: PARTNER, action: 'updated',
      editor: { kind: 'person', userId: 'user-erin', name: 'erin@example.test', via: null },
      changes: AUDIT[0].changes,
    })
    expect(body.entries[1]).toMatchObject({
      source: 'bid_config_history', entityType: 'bid_matrix', entityId: CONFIG, action: 'synced',
      editor: { kind: 'person', userId: 'user-1', name: 'Dan Wright', via: 'sync_now' },
      matrix: { configId: CONFIG, configName: 'SoFi default', source: 'salesforce_sync' },
      changes: MATRIX[0].diff,
    })
    expect(body.entries[2].editor).toEqual({ kind: 'direct' })
    expect(body.entries[3].editor).toEqual({ kind: 'job', job: 'salesforce_matrix_sync' })
    expect(body.entries[4].editor).toEqual({ kind: 'person', userId: null, name: 'Stamped Sam', via: null })
    // Never a uuid where a name belongs.
    for (const e of body.entries) expect(e.editorLabel).not.toMatch(/user-|[0-9a-f]{8}-[0-9a-f]{4}/)

    // Every read is this organization's, and each is bounded and ordered.
    expect(supabase.eqCalls['partner_configs']).toEqual([['id', PARTNER], ['organization_id', ORG]])
    expect(supabase.eqCalls['partner_bid_configs']).toEqual([['partner_id', PARTNER], ['organization_id', ORG]])
    expect(supabase.eqCalls['audit_log']).toEqual([['organization_id', ORG]])
    const auditCalls = supabase.calls['audit_log']
    const or = auditCalls.find(([m]) => m === 'or')?.[1][0] as string
    expect(or).toContain(`and(entity_type.in.(partner_config,buyer_profile),entity_id.eq.${PARTNER})`)
    expect(or).toContain(`and(entity_type.eq.partner_bid_config,entity_id.in.(${CONFIG}))`)
    expect(or).toContain(`and(entity_type.eq.partner_bid_config,changes->>partner_id.eq.${PARTNER})`)
    expect(or).toContain(`and(entity_type.eq.partner_uuid,changes->>partner_id.eq.${PARTNER})`)
    expect(or).toContain(`and(entity_type.eq.partner_uuid,changes->>old_partner_id.eq.${PARTNER})`)
    expect(or).toContain(`and(entity_type.eq.held_click,changes->subject->>partner_id.eq.${PARTNER})`)
    expect(or).toContain(`and(entity_type.eq.held_click,changes->held_click->old->>partner_id.eq.${PARTNER})`)
    expect(auditCalls).toContainEqual(['range', [0, 999]])
    expect(supabase.calls['bid_config_history']).toContainEqual(['in', ['config_id', [CONFIG]]])
    expect(supabase.calls['bid_config_history']).toContainEqual(['range', [0, 999]])
    // Editor names are read by id across organizations, so a person moved out
    // of this one still resolves; the ids come from this organization's rows.
    expect(supabase.calls['users']).toContainEqual(['in', ['id', ['user-erin', 'user-1']]])
  })

  it('reads no matrix history for a partner with no matrix config, and no users for rows with no editor', async () => {
    const supabase = wire({
      partner_bid_configs: { list: [] },
      audit_log: { list: [AUDIT[1]] },
    })
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json() as PartnerHistory
    expect(body.entries.map((e) => e.key)).toEqual(['audit:a2'])
    expect(supabase.calls['bid_config_history']).toBeUndefined()
    expect(supabase.calls['users']).toBeUndefined()
    const or = supabase.calls['audit_log'].find(([m]) => m === 'or')?.[1][0] as string
    expect(or).not.toContain('entity_id.in.()')
  })

  it('answers 404 for a partner outside the organization, and for an id that is not a uuid, before reading history', async () => {
    const supabase = wire({ partner_configs: { single: null } })
    expect((await get()).status).toBe(404)
    expect(supabase.calls['audit_log']).toBeUndefined()

    const again = wire({})
    expect((await get('not-a-uuid),or(id.neq.0')).status).toBe(404)
    expect(again.calls['partner_configs']).toBeUndefined()
  })

  // Each read made to fail in turn: the answer is an error naming that read,
  // never a shorter list and never an editor with no name.
  const FAILURES: Array<[string, Record<string, TableConfig | TableConfig[]>]> = [
    ['partner_configs', { partner_configs: { singleError: { code: '57014', message: 'timeout' } } }],
    ['partner_bid_configs', { partner_bid_configs: { listError: { code: '57014', message: 'timeout' } } }],
    ['audit_log', { partner_bid_configs: { list: [{ id: CONFIG, name: 'SoFi default' }] }, audit_log: { listError: { code: '57014', message: 'timeout' } }, bid_config_history: { list: MATRIX }, users: { list: [DAN] } }],
    ['bid_config_history', { partner_bid_configs: { list: [{ id: CONFIG, name: 'SoFi default' }] }, audit_log: { list: AUDIT }, bid_config_history: { listError: { code: '57014', message: 'timeout' } }, users: { list: [ERIN, DAN] } }],
    ['users', { partner_bid_configs: { list: [{ id: CONFIG, name: 'SoFi default' }] }, audit_log: { list: AUDIT }, bid_config_history: { list: MATRIX }, users: { listError: { code: '57014', message: 'timeout' } } }],
  ]
  for (const [read, tables] of FAILURES) {
    it(`answers an error naming the ${read} read when it fails, never a partial history`, async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      wire(tables)
      const res = await get()
      expect(res.status).toBe(500)
      const body = await res.json() as Record<string, unknown>
      expect(body).toEqual({ error: 'history_unavailable', read, message: `History could not be loaded: the ${read} read failed.` })
      expect(body).not.toHaveProperty('entries')
      // The real error is in the Worker log, never in the answer.
      expect(errors.mock.calls.some((c) => String(c[0]).includes(`[partner-history] ${read} read failed`))).toBe(true)
    })
  }

  it('is an error, never an unnamed editor, when an editor has no users row', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    wire({ partner_bid_configs: { list: [] }, audit_log: { list: [AUDIT[0]] }, users: { list: [] } })
    const res = await get()
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'history_unavailable', read: 'users' })
  })
})
