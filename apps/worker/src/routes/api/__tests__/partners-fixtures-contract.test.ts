/**
 * The partners page fixtures match the routes that answer them (#2134).
 *
 * The accessibility job answers every Worker call the partners page makes from
 * apps/web/e2e/fixtures/partners/ (plan #2130, Rules). A fixture that drifted
 * from its route would have the scan pass over a page production never shows,
 * so each one is held here to what the REAL route answers when the database
 * gives it the fixture's rows: the partner list, each buyer's profile read, the
 * sub-account IDs, and the stale save's 409 the merge dialog opens from.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/partner-constants-loader')
vi.mock('../../../lib/buyer-profile-loader')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { readBuyerSale, readBuyerSoldOn, refreshBuyerProfilesCache } from '../../../lib/buyer-profile-loader'
import { partnerConstantsFromRows } from '../../../lib/partner-constants-loader'
import { makeSupabase, type TableConfig } from './_supabase-mock'

// The fixtures the accessibility job is answered from (apps/web/e2e/fixtures/partners).
import partnersJson from '../../../../../web/e2e/fixtures/partners/partners.json'
import buyerProfilesJson from '../../../../../web/e2e/fixtures/partners/buyer-profiles.json'
import uuidsJson from '../../../../../web/e2e/fixtures/partners/partner-uuids.json'
import staleJson from '../../../../../web/e2e/fixtures/partners/synthetic/page-save-409.tripoint.json'
import usageJson from '../../../../../web/e2e/fixtures/partners/usage.json'
import workflowValuesJson from '../../../../../web/e2e/fixtures/partners/workflow-values.json'
import type { WorkflowValuesAnswer } from '../../../lib/workflow-values-shape'

type Row = Record<string, unknown> & { id: string; slug: string; partner_type: string; accept_signals: unknown }
const partners = partnersJson as unknown as Row[]
const buyerProfiles = buyerProfilesJson as unknown as Record<string, { profile: Record<string, unknown> | null; accept_signals: unknown[]; other_sellers: Array<{ id: string; name: string }> }>
const uuids = uuidsJson as unknown[]
const stale = staleJson as unknown as Record<string, unknown> & { partner: Row; profile: Record<string, unknown> }

const testUser = { id: 'user-1', organization_id: String(partners[0].organization_id), email: 'editor-a@example.com' }
const validPayload = { sub: 'user-1', email: 'editor-a@example.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
/** Both secrets the captured partners name are set on the production Worker (wrangler secret list, 2026-10-15). */
const env = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: { get: async () => null, put: async () => {}, delete: async () => {} }, AMONE_PROXY_SECRET: 's', TRIPOINT_PROXY_SECRET: 's' } as unknown as Env

const withoutWarning = ({ credential_warning: _w, ...row }: Row) => row

function supabaseWith(tables: Record<string, TableConfig | TableConfig[]>, rpc?: (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>) {
  vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser }, ...tables }, rpc ? { rpc } : {}) as unknown as ReturnType<typeof createSupabaseClient>)
}

// The route tree is imported once, before the tests, so its cold import (seconds
// on a busy machine) is not charged to whichever test happens to run first.
let api: Awaited<typeof import('../index')>['default']
beforeAll(async () => { api = (await import('../index')).default }, 60_000)

async function call(method: string, route: string, body?: unknown) {
  return api.request(route, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: body === undefined ? undefined : JSON.stringify(body) }, env, mockCtx)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyJwt).mockResolvedValue(validPayload)
  vi.mocked(refreshBuyerProfilesCache).mockResolvedValue({} as Awaited<ReturnType<typeof refreshBuyerProfilesCache>>)
  vi.mocked(readBuyerSoldOn).mockResolvedValue('offer')
  vi.mocked(readBuyerSale).mockResolvedValue(null)
})

describe('the partners page fixtures are what their routes answer (#2134)', () => {
  it('GET /partners: the list, each row with its credential warning', async () => {
    supabaseWith({ partner_configs: { list: partners.map(withoutWarning) } })
    const res = await call('GET', '/partners')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(partners)
  })

  it.each(Object.keys(buyerProfiles).map((id) => [partners.find((p) => p.id === id)!.slug, id]))('GET /partners/:id/buyer-profile for %s', async (_slug, id) => {
    const row = partners.find((p) => p.id === id)!
    const fixture = buyerProfiles[id]
    // The live workflows that name a buyer, as the fixture's other sellers say: one
    // workflow whose Bid Group lists them, which is how Main Flow names them.
    // Each row carries the organization and deleted_at the shared read selects and checks (#2142).
    const workflows = fixture.other_sellers.map((w) => ({ ...w, is_active: true, organization_id: testUser.organization_id, deleted_at: null, definition: { nodes: [{ type: 'bid_group', config: { partner_ids: [id] } }] } }))
    supabaseWith(
      { partner_configs: { single: withoutWarning(row) }, workflows: { list: workflows } },
      async (name) => ({ data: name === 'buyer_profile_document' ? fixture.profile : null, error: null }),
    )
    const res = await call('GET', `/partners/${id}/buyer-profile`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(fixture)
  })

  // #2137: the usage read the Bid Group tab is shown from. The fixture was
  // measured from production's workflows (read only, 2026-10-16); here the route
  // is given workflows whose steps say exactly that, and must answer the fixture.
  it.each(Object.keys(usageJson).map((id) => [partners.find((p) => p.id === id)!.slug, id]))('GET /partners/:id/usage for %s', async (_slug, id) => {
    type Step = { workflow_id: string; workflow_name: string; is_active: boolean; node_id: string }
    type BidGroupStep = Step & { mode: string; partner_ids: string[]; fallback_partner_id: string | null }
    const usage = usageJson as Record<string, { bid_group: BidGroupStep[]; partner_bid: Step[]; latency_gate: Step[] }>
    // Every step of every kind the fixture records, rebuilt as the node that would
    // answer it: each partner's own steps name it by partner_id.
    const workflows = new Map<string, { id: string; name: string; is_active: boolean; organization_id: string; deleted_at: null; definition: { nodes: Array<Record<string, unknown>> } }>()
    const add = (s: Step, node: Record<string, unknown>) => {
      const w = workflows.get(s.workflow_id) ?? { id: s.workflow_id, name: s.workflow_name, is_active: s.is_active, organization_id: testUser.organization_id, deleted_at: null, definition: { nodes: [] } }
      if (!w.definition.nodes.some((n) => n.id === node.id && n.type === node.type && JSON.stringify(n) === JSON.stringify(node))) w.definition.nodes.push(node)
      workflows.set(s.workflow_id, w)
    }
    for (const [pid, u] of Object.entries(usage)) {
      for (const s of u.bid_group) add(s, { id: s.node_id, type: 'bid_group', config: { mode: s.mode, partner_ids: s.partner_ids, fallback_partner_id: s.fallback_partner_id } })
      for (const s of u.partner_bid) add(s, { id: s.node_id, type: 'partner_bid', config: { partner_id: pid } })
      for (const s of u.latency_gate) add(s, { id: s.node_id, type: 'latency_gate', config: { partner_id: pid } })
    }
    supabaseWith({ partner_configs: { single: { id } }, workflows: { list: [...workflows.values()] } })
    const res = await call('GET', `/partners/${id}/usage`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(usage[id])
  })

  it('the usage fixture has an answer for every listed partner', () => {
    expect(Object.keys(usageJson).sort()).toEqual(partners.map((p) => p.id).sort())
  })

  // #2142: the Workflow values tab's read. The fixture was built through the
  // route's own code from production's workflows (read only, 2026-10-16,
  // scripts/measure-workflow-values-e2e-fixture.ts). Here the route is given the
  // fixture's partner rows and sub-account ids, and workflows whose steps read
  // exactly what the fixture says each place reads, and must answer the fixture.
  describe('GET /partners/:id/workflow-values', () => {
    const answers = workflowValuesJson as unknown as Record<string, WorkflowValuesAnswer>
    const allIds = uuidsJson as Array<{ uuid: string; partner_slug: string }>

    // The loader is mocked for the other routes; this route builds its values through the real one.
    beforeEach(async () => {
      const real = await vi.importActual<typeof import('../../../lib/partner-constants-loader')>('../../../lib/partner-constants-loader')
      vi.mocked(partnerConstantsFromRows).mockImplementation(real.partnerConstantsFromRows)
    })

    /** One script line per read the fixture records, in the form the scanner matches. */
    function readLine(v: WorkflowValuesAnswer['values'][number], slug: string, how: 'by_name' | 'every_partner'): string {
      if (how === 'every_partner') return v.map ? `Object.keys(constants.${v.constant_name})` : 'constants[name]'
      if (v.kind === 'activeBidding') return `constants.activeBidding.${slug}`
      if (v.kind === 'subAccountIdsMap') return `constants.subAccountIdsMap['${allIds.find((u) => u.partner_slug === slug)!.uuid}']`
      return `constants.${v.constant_name}`
    }

    function workflowsOf() {
      type Node = { id: string; namespace: string; label: string | null; type: string; config: { script?: string[]; data?: Record<string, null> } }
      const wfs = new Map<string, { id: string; name: string; is_active: boolean; organization_id: string; deleted_at: null; nodes: Node[] }>()
      const wf = (id: string, name: string, isActive: boolean) => {
        const w = wfs.get(id) ?? { id, name, is_active: isActive, organization_id: testUser.organization_id, deleted_at: null, nodes: [{ id: `${id}-constants`, namespace: 'constants', label: 'Constants', type: 'constants', config: { data: {} } }] }
        wfs.set(id, w)
        return w
      }
      for (const a of Object.values(answers)) {
        for (const v of a.values) {
          for (const r of v.readers) {
            const w = wf(r.workflow_id, r.workflow_name, r.is_active)
            for (const p of r.places) {
              let n = w.nodes.find((x) => x.id === p.node_id)
              if (!n) w.nodes.push((n = { id: p.node_id!, namespace: p.namespace!, label: p.label, type: p.node_type!, config: { script: [] } }))
              const line = readLine(v, a.partner.slug, p.reads)
              if (!n.config.script!.includes(line)) n.config.script!.push(line)
            }
          }
          for (const s of v.shadowed_data_keys) wf(s.workflow_id, s.workflow_name, s.is_active).nodes[0].config.data![v.constant_name] = null
        }
      }
      // The rest of what was searched: workflows with a Constants step that read nothing, then workflows without one.
      const { workflows: total, with_constants_node: withConstants } = Object.values(answers)[0].searched
      for (let i = wfs.size; i < withConstants; i++) wf(`ffff${i}`, `Reads nothing ${i}`, true)
      const list = [...wfs.values()].map(({ nodes, ...w }) => ({ ...w, definition: { nodes: nodes.map((n) => ({ ...n, config: n.config.script ? { script: n.config.script.join('\n') } : n.config })), edges: [] } }))
      for (let i = list.length; i < total; i++) list.push({ id: `fffff${i}`, name: `No Constants step ${i}`, is_active: true, organization_id: testUser.organization_id, deleted_at: null, definition: { nodes: [], edges: [] } })
      return list.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    }

    it('the fixture has an answer for every listed partner, each over the same search', () => {
      expect(Object.keys(answers).sort()).toEqual(partners.map((p) => p.id).sort())
      expect(new Set(Object.values(answers).map((a) => JSON.stringify(a.searched))).size).toBe(1)
    })

    it.each(Object.keys(answers).map((id) => [partners.find((p) => p.id === id)!.slug, id]))('for %s', async (slug, id) => {
      const row = partners.find((p) => p.id === id)!
      supabaseWith({
        partner_configs: { single: withoutWarning(row) },
        partner_uuid_map: { list: allIds.filter((u) => u.partner_slug === slug) },
        workflows: { list: workflowsOf() },
      })
      const res = await call('GET', `/partners/${id}/workflow-values`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(answers[id])
    })
  })

  it('GET /partner-uuids: the sub-account IDs', async () => {
    supabaseWith({ partner_uuid_map: { list: uuids as Record<string, unknown>[] } })
    const res = await call('GET', '/partner-uuids')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(uuids)
  })

  it('PUT /partners/:id/page: the stale save the merge dialog opens from is the 409 the route answers', async () => {
    const { error: _e, ...detail } = stale
    const tripoint = partners.find((p) => p.id === stale.partner.id)!
    const mine = { ...buyerProfiles[tripoint.id].profile, daily_lead_cap: 300 }
    supabaseWith(
      { partner_configs: { single: { id: tripoint.id, click_url: tripoint.click_url, accept_signals: tripoint.accept_signals, external_routing_code: tripoint.external_routing_code } }, workflows: { list: [] } },
      async (name) => (name === 'save_partner_page' ? { data: null, error: { code: 'BP409', message: 'stale_version', details: JSON.stringify(detail) } } : { data: null, error: null }),
    )
    const res = await call('PUT', `/partners/${tripoint.id}/page`, { expected_partner_version: 0, patch: {}, expected_profile_version: 5, profile: mine, save_id: '0b9f6c1e-3c2a-4d7e-8f10-2a3b4c5d6e7f' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(stale)
  })
})
