/**
 * The delete box inside the tabbed partner form (#2140, PM-13).
 *
 * The box sits at the foot of the Partner tab. A delete it started must reach
 * the page whatever tab the person moves to while it runs: the server commits
 * it either way, so a box that unmounted would leave the page showing a
 * partner that no longer exists. And the page's own delete, heard back on the
 * live channel, is not another person's delete.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'

vi.mock('@/lib/api', () => ({
  api: {
    partners: {
      usage: () => Promise.resolve({ bid_group: [], partner_bid: [], latency_gate: [] }),
      get: vi.fn(), versions: vi.fn(), reportLiveMiss: vi.fn(), workflowValues: vi.fn(), deleteCheck: vi.fn(), delete: vi.fn(), history: vi.fn(),
    },
    partnerUuids: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    partnerBidConfigs: { list: vi.fn() },
    buyerProfiles: { get: vi.fn(), usage: vi.fn() },
    buyerSales: { list: vi.fn(), settle: vi.fn() },
  },
}))

import PartnerForm from '../PartnerForm'
import { api } from '@/lib/api'
import type { Partner, PartnerDeleteCheck, PartnerDeleted } from '@/lib/api'
import { PartnerLiveContext, type PartnerLiveDeps } from '@/components/partners/live/PartnerLive'
import type { JoinFn } from '@/lib/partner-live-channel'
import { leaveThen } from '@/lib/leave-guard'

const ORG = '9d9d0d3a-1959-41d5-95ca-c1399fa54590'
const ID = '2b0c6c39-1d1e-4a3f-9d0f-3c0b5a6e7f81'

const partner: Partner = {
  id: ID, organization_id: ORG, name: 'M1', slug: 'm1', api_endpoint: null, cf_secret_key: null, daily_cap: null, min_bid: null,
  bid_formula: null, bid_resolver_type: 'api', bid_resolver_config: {}, outbound_field_mapping: null,
  bid_comparison_source: 'auto', extra_extraction: null, last_probe_response: null, dedup_endpoint: null, response_classification: null,
  alert_config: null, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 300, circuit_enabled: true,
  confirmation_window_ms: null, is_active: true, priority: 0, sell_off_offer_title: null, sell_off_offer_details: null, click_url: null,
  sub_account_min_bids: null, partner_type: 'source', created_at: '', updated_at: '2026-10-15T14:00:00Z', updated_by_email: null, updated_by_name: null,
  version: 3,
}

const check: PartnerDeleteCheck = {
  partner: { id: ID, name: 'M1', slug: 'm1', partner_type: 'source', is_active: true },
  blockers: [],
  removes: [{ table: 'partner_uuid_map', kind: 'deleted', rows: 2, noun: { one: 'sub-account ID', many: 'sub-account IDs' } }],
  workflows_naming_partner: [],
  workflows_reading_values: [],
  secret: null,
  fingerprint: { counts: { partner_uuid_map: 2 }, workflows: [] },
}

/** A live channel the test delivers notices on; the clock never fires a timer. */
function liveHarness() {
  let deliver: (payload: unknown) => void = () => {}
  const join: JoinFn = async (_topic, onPayload) => {
    deliver = onPayload
    return { ok: true, leave: async () => {} }
  }
  const deps: PartnerLiveDeps = { join, clock: { now: () => Date.parse('2026-10-16T14:35:00.000Z'), setTimeout: () => () => {} } }
  return { deps, send: (payload: unknown) => act(async () => { deliver(payload) }) }
}

function renderForm(deps: PartnerLiveDeps, onDeleted = vi.fn()) {
  const wrap = ({ children }: { children: ReactNode }) => <PartnerLiveContext.Provider value={deps}>{children}</PartnerLiveContext.Provider>
  render(<PartnerForm partner={partner} onSave={vi.fn()} onCancel={vi.fn()} onDeleted={onDeleted} />, { wrapper: wrap })
  return onDeleted
}

/** Opens the Partner tab and presses Delete with DELETE typed; the delete answers when the test says. */
async function startDelete() {
  let answer!: (a: PartnerDeleted) => void
  vi.mocked(api.partners.delete).mockReturnValue(new Promise((r) => { answer = r }))
  await userEvent.click(await screen.findByRole('tab', { name: 'Partner' }))
  await userEvent.type(await screen.findByLabelText('Type DELETE to confirm'), 'DELETE')
  await userEvent.click(screen.getByRole('button', { name: 'Delete M1' }))
  await screen.findByText(/Deleting M1/)
  return (a: PartnerDeleted) => act(async () => { answer(a) })
}

beforeEach(() => {
  vi.clearAllMocks()
  // A queued answer a failed test left behind must not answer the next test.
  vi.mocked(api.partners.delete).mockReset()
  vi.mocked(api.partnerUuids.list).mockResolvedValue([])
  vi.mocked(api.partnerBidConfigs.list).mockResolvedValue([])
  vi.mocked(api.buyerProfiles.get).mockResolvedValue({ profile: null, accept_signals: [], other_sellers: [] })
  vi.mocked(api.partners.versions).mockResolvedValue({ partnerId: ID, partnerVersion: 3, profileVersion: 0, lastSaveId: null, profileLastSaveId: null, latestChange: null, newest: { partner: null, profile: null } })
  vi.mocked(api.partners.workflowValues).mockResolvedValue({ partner: { id: ID, slug: 'm1' }, values: [], searched: { workflows: 0, with_constants_node: 0 } })
  vi.mocked(api.partners.deleteCheck).mockResolvedValue(check)
  // The History tab a test moves to reads the partner history (#2141).
  vi.mocked(api.partners.history).mockResolvedValue({ partnerId: ID, entries: [], complete: true, completeSince: null })
})

describe('a delete is not an unsaved edit (#2138 with #2140)', () => {
  it('DELETE typed in the box, and the delete running, raise no save bar, no leave question and no browser warning', async () => {
    const { deps } = liveHarness()
    renderForm(deps)
    await startDelete()
    expect(document.querySelector('[data-save-bar]')).toBeNull()
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(false)
    const go = vi.fn()
    leaveThen({ kind: 'partner', name: 'AmOne' }, go)
    expect(go).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('a delete in flight while the person changes tab (#2140)', () => {
  it('still reaches the page when it commits, and the running delete stays on screen on the other tab', async () => {
    const { deps } = liveHarness()
    const onDeleted = renderForm(deps)
    const answer = await startDelete()
    await userEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(screen.getByText(/Deleting M1/)).toBeTruthy()
    await answer({ ok: true })
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(ID, { ok: true }))
  })

  it('a delete that fails after the person changed tab says so on that tab, until they return to the Partner tab', async () => {
    const { deps } = liveHarness()
    const onDeleted = renderForm(deps)
    let fail!: (e: unknown) => void
    vi.mocked(api.partners.delete).mockReturnValue(new Promise((_r, j) => { fail = j }))
    await userEvent.click(await screen.findByRole('tab', { name: 'Partner' }))
    await userEvent.type(await screen.findByLabelText('Type DELETE to confirm'), 'DELETE')
    await userEvent.click(screen.getByRole('button', { name: 'Delete M1' }))
    await userEvent.click(screen.getByRole('tab', { name: 'History' }))
    await act(async () => { fail(Object.assign(new Error('The server could not be reached.'), { status: 503 })) })
    expect(await screen.findByRole('alert')).toHaveTextContent('The server could not be reached.')
    expect(onDeleted).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('tab', { name: 'Partner' }))
    await userEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(screen.queryByRole('region', { name: 'Delete M1' })).toBeNull()
  })

  it('a delete that fails or is refused while the person is on the Partner tab does not follow them to another tab', async () => {
    const { deps } = liveHarness()
    renderForm(deps)
    vi.mocked(api.partners.delete)
      .mockRejectedValueOnce(Object.assign(new Error('The server could not be reached.'), { status: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409, body: { error: 'consequence_changed', message: 'What this delete would remove changed since it was shown. Nothing was deleted. Review it again below.', check } }))
    await userEvent.click(await screen.findByRole('tab', { name: 'Partner' }))
    for (const seen of [/may still have gone through/, /changed since it was shown/]) {
      await userEvent.type(await screen.findByLabelText('Type DELETE to confirm'), 'DELETE')
      await userEvent.click(screen.getByRole('button', { name: 'Delete M1' }))
      expect(await screen.findByText(seen)).toBeTruthy()
      await userEvent.click(screen.getByRole('tab', { name: 'History' }))
      expect(screen.queryByRole('region', { name: 'Delete M1' }), String(seen)).toBeNull()
      await userEvent.click(screen.getByRole('tab', { name: 'Partner' }))
    }
  })

  it('the page\'s own delete heard on the live channel is not reported as someone else deleting the partner', async () => {
    const h = liveHarness()
    renderForm(h.deps)
    await screen.findByText('Live')
    const answer = await startDelete()
    await h.send({ partner_id: ID, partner_version: null, profile_version: null, save_id: null, client_id: null, kind: 'deleted', changed_columns: null, direct: false })
    expect(screen.queryByText(/was deleted while you were editing/)).toBeNull()
    await answer({ ok: true })
  })

  it('another person\'s delete, with none running here, still says so', async () => {
    const h = liveHarness()
    renderForm(h.deps)
    await screen.findByText('Live')
    await h.send({ partner_id: ID, partner_version: null, profile_version: null, save_id: null, client_id: null, kind: 'deleted', changed_columns: null, direct: false })
    expect(await screen.findByText('M1 was deleted while you were editing, so these changes cannot be saved.')).toBeTruthy()
  })
})
