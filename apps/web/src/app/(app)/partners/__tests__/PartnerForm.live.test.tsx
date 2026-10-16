/**
 * The partners page hears another person's save live (#2135, PM-2).
 *
 * A notice on partners:<org> makes the page read the partner again through the
 * Worker and merge it with what is on screen (#2134's merge): a field only they
 * changed updates in place and its section says who; a field both changed is
 * left as typed, the save bar says so, and Save asks in the merge dialog. The
 * tab knows its own save by client_id plus save_id. While the draft is dirty a
 * probe asks for the versions every minute and reports a change no notice
 * announced. The channel and the clock are fakes, so nothing waits on a real
 * timer (L524).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('@/lib/api', () => ({
  api: {
    partners: { usage: () => Promise.resolve({ bid_group: [], partner_bid: [], latency_gate: [] }), get: vi.fn(), versions: vi.fn(), reportLiveMiss: vi.fn() },
    partnerUuids: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    partnerBidConfigs: { list: vi.fn() },
    buyerProfiles: { get: vi.fn(), history: vi.fn(), usage: vi.fn() },
    buyerSales: { list: vi.fn(), settle: vi.fn() },
  },
}))

import PartnerForm from '../PartnerForm'
import { api } from '@/lib/api'
import type { Partner, PartnerPageVersions } from '@/lib/api'
import { PartnerLiveContext, type PartnerLiveDeps } from '@/components/partners/live/PartnerLive'
import type { JoinFn } from '@/lib/partner-live-channel'
import { PROBE_EVERY_MS } from '@/lib/partner-live-page'
import { BIDDING_PICKUP } from '@/lib/bidding-pickup'

const ORG = '9d9d0d3a-1959-41d5-95ca-c1399fa54590'
const ID = '2b0c6c39-1d1e-4a3f-9d0f-3c0b5a6e7f81'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const START = Date.parse('2026-10-16T14:35:00.000Z')

const partner: Partner = {
  id: ID, organization_id: ORG, name: 'M1', slug: 'm1', api_endpoint: null, cf_secret_key: null, daily_cap: null, min_bid: null,
  bid_formula: null, bid_resolver_type: 'api', bid_resolver_config: {}, outbound_field_mapping: null, bid_mode: 'ping_only',
  bid_comparison_source: 'auto', extra_extraction: null, last_probe_response: null, dedup_endpoint: null, response_classification: null,
  alert_config: null, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 300, circuit_enabled: true,
  confirmation_window_ms: null, is_active: true, priority: 0, sell_off_offer_title: null, sell_off_offer_details: null, click_url: null,
  sub_account_min_bids: null, partner_type: 'source', created_at: '', updated_at: '2026-10-15T14:00:00Z', updated_by_email: null, updated_by_name: null,
  version: 3,
}

const versions = (over: Partial<PartnerPageVersions> = {}): PartnerPageVersions => ({
  partnerId: ID, partnerVersion: 3, profileVersion: 0, lastSaveId: null, profileLastSaveId: null, latestChange: null, newest: { partner: null, profile: null }, ...over,
})

/** A clock whose timers run only when the test advances it. */
function fakeClock() {
  let now = START
  let timers: Array<{ at: number; fn: () => void; id: number }> = []
  let next = 1
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = next++
      timers.push({ at: now + ms, fn, id })
      return () => { timers = timers.filter((t) => t.id !== id) }
    },
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers = timers.filter((t) => t.id !== due.id)
        now = due.at
        await act(async () => { due.fn() })
      }
      now = end
    },
  }
}

function liveHarness() {
  const clock = fakeClock()
  let deliver: (payload: unknown) => void = () => {}
  const join: JoinFn = async (_topic, onPayload) => {
    deliver = onPayload
    return { ok: true, leave: async () => {} }
  }
  const deps: PartnerLiveDeps = { join, clock }
  return { deps, clock, send: (payload: unknown) => act(async () => { deliver(payload) }) }
}

const notice = (over: Record<string, unknown> = {}) => ({
  partner_id: ID, partner_version: 4, profile_version: 0, save_id: null, client_id: null, kind: 'partner', changed_columns: ['name'], direct: false, ...over,
})

function renderLive(deps: PartnerLiveDeps, onSave = vi.fn().mockResolvedValue({ partner: { ...partner, version: 4 }, profile: null, copyWarning: null })) {
  const wrap = ({ children }: { children: ReactNode }) => <PartnerLiveContext.Provider value={deps}>{children}</PartnerLiveContext.Provider>
  render(<PartnerForm partner={partner} onSave={onSave} onCancel={vi.fn()} />, { wrapper: wrap })
  return onSave
}

const nameBox = () => screen.getByLabelText('Name') as HTMLInputElement
const save = () => fireEvent.click(document.querySelector('button[type="submit"]')!)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.partnerUuids.list).mockResolvedValue([])
  vi.mocked(api.partnerBidConfigs.list).mockResolvedValue([])
  vi.mocked(api.buyerProfiles.get).mockResolvedValue({ profile: null, accept_signals: [], other_sellers: [] })
  vi.mocked(api.partners.versions).mockResolvedValue(versions())
  vi.mocked(api.partners.reportLiveMiss).mockResolvedValue({ ok: true, id: 'miss-1' })
})

describe('another person\'s save, live (#2135)', () => {
  it('says Live once joined, and with no live channel shows no status at all', async () => {
    const { deps } = liveHarness()
    renderLive(deps)
    expect(await screen.findByText('Live')).toBeTruthy()
    cleanup()
    render(<PartnerForm partner={partner} onSave={vi.fn()} onCancel={vi.fn()} />)
    await screen.findByLabelText('Name')
    expect(screen.queryByText(/^Live$|live updates/i)).toBeNull()
    expect(api.partners.versions).toHaveBeenCalledTimes(1)
  })

  it('a field only they changed updates in place, its section says who, the bar names it, and the next save is made from their version', async () => {
    const h = liveHarness()
    vi.mocked(api.partners.get).mockResolvedValue({ ...partner, name: 'M1 (theirs)', version: 4, updated_by_name: 'Brian Nelms' })
    const onSave = renderLive(h.deps)
    await screen.findByText('Live')
    await h.send(notice())
    await waitFor(() => expect(nameBox().value).toBe('M1 (theirs)'))
    expect(api.partners.get).toHaveBeenCalledWith(ID)
    expect(screen.getByText('Updated by Brian Nelms: Name.')).toBeTruthy()
    expect(screen.getByText('Brian Nelms saved this partner. Their change to Name is on screen.')).toBeTruthy()
    // Their change is not this person's unsaved change.
    expect(screen.queryByText('Unsaved changes')).toBeNull()

    fireEvent.change(nameBox(), { target: { value: 'M1 (mine)' } })
    save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const [body, , , request] = onSave.mock.calls[0]
    expect(body).toEqual({ name: 'M1 (mine)' })
    expect(request.expected_partner_version).toBe(4)
    expect(request.client_id).toMatch(UUID_RE)
  })

  it('a field both changed is left as typed, the save bar says so, and Save asks in the merge dialog instead of saving', async () => {
    const h = liveHarness()
    vi.mocked(api.partners.get).mockResolvedValue({ ...partner, name: 'M1 (theirs)', is_active: false, version: 4, updated_by_name: 'Brian Nelms' })
    const onSave = renderLive(h.deps)
    await screen.findByText('Live')
    fireEvent.change(nameBox(), { target: { value: 'M1 (mine)' } })
    await h.send(notice({ changed_columns: ['name', 'is_active'] }))
    await screen.findByText('Brian Nelms changed 1 field you are editing. You choose when you save.')
    expect(nameBox().value).toBe('M1 (mine)')
    expect(screen.getByText('Updated by Brian Nelms: Status.')).toBeTruthy()

    save()
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('its own save\'s notice is not refetched, known by this tab\'s client_id and the save id it sent; the same save id from another tab is', async () => {
    const h = liveHarness()
    vi.mocked(api.partners.get).mockResolvedValue({ ...partner, version: 5 })
    const onSave = renderLive(h.deps)
    await screen.findByText('Live')
    fireEvent.change(nameBox(), { target: { value: 'M1 renamed' } })
    save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const request = onSave.mock.calls[0][3]
    await h.send(notice({ kind: 'page', save_id: request.save_id, client_id: request.client_id }))
    expect(api.partners.get).not.toHaveBeenCalled()
    await h.send(notice({ kind: 'page', partner_version: 5, save_id: request.save_id, client_id: '66666666-6666-4666-8666-666666666666' }))
    await waitFor(() => expect(api.partners.get).toHaveBeenCalledTimes(1))
  })

  it('the probe, while dirty, finds a change no notice announced: the header pauses, the miss is reported, and their save is merged', async () => {
    const h = liveHarness()
    vi.mocked(api.partners.get).mockResolvedValue({ ...partner, priority: 7, version: 4, updated_by_name: 'Brian Nelms' })
    renderLive(h.deps)
    await screen.findByText('Live')
    await waitFor(() => expect(api.partners.versions).toHaveBeenCalledTimes(1))
    fireEvent.change(nameBox(), { target: { value: 'M1 (mine)' } })
    vi.mocked(api.partners.versions).mockResolvedValue(versions({ partnerVersion: 4, latestChange: { section: 'partner', changedAt: '2026-10-16T14:35:30.000Z', direct: false, fields: ['priority'] } }))
    await h.clock.advance(PROBE_EVERY_MS)
    await waitFor(() => expect(api.partners.reportLiveMiss).toHaveBeenCalledTimes(1))
    expect(api.partners.reportLiveMiss).toHaveBeenCalledWith({
      partner_id: ID, cause: 'delivery',
      noticed: { partner_version: 3, profile_version: null }, observed: { partner_version: 4, profile_version: 0 },
      since_last_notice_ms: null,
    })
    expect(await screen.findByText(/Live updates paused\. Reconnecting/)).toBeTruthy()
    await waitFor(() => expect(api.partners.get).toHaveBeenCalledWith(ID))
    await screen.findByText('Brian Nelms saved this partner. Their change to List order is on screen.')
    expect(nameBox().value).toBe('M1 (mine)')
  })

  it('a change made directly in the database is noted on its section on open, and the note goes once the bound has passed', async () => {
    const h = liveHarness()
    vi.mocked(api.partners.versions).mockResolvedValue(versions({
      latestChange: { section: 'partner', changedAt: '2026-10-16T14:34:00.000Z', direct: true, fields: ['name'] },
      newest: { partner: { changedAt: '2026-10-16T14:34:00.000Z', direct: true, fields: ['name'] }, profile: null },
    }))
    renderLive(h.deps)
    const sentence = `Changed directly in the database at 10:34 AM ET. Bidding picks this up within about ${BIDDING_PICKUP.partnerConstantsMinutes} minutes of that time while the database is reachable.`
    expect(await screen.findByText(sentence)).toBeTruthy()
    await h.clock.advance(BIDDING_PICKUP.partnerConstantsMinutes * 60_000)
    await waitFor(() => expect(screen.queryByText(sentence)).toBeNull())
  })

  it('a sub-account ID change re-reads the list, and the monitor\'s ping or another partner is ignored', async () => {
    const h = liveHarness()
    renderLive(h.deps)
    await screen.findByText('Live')
    await waitFor(() => expect(api.partnerUuids.list).toHaveBeenCalledTimes(1))
    await h.send(notice({ kind: 'uuids', partner_version: 3 }))
    await waitFor(() => expect(api.partnerUuids.list).toHaveBeenCalledTimes(2))
    await h.send(notice({ kind: 'monitor' }))
    await h.send(notice({ partner_id: '7e0c6c39-1d1e-4a3f-9d0f-3c0b5a6e7f82' }))
    expect(api.partners.get).not.toHaveBeenCalled()
  })
})
