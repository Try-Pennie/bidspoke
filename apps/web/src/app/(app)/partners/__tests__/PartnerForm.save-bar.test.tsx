/**
 * The partners page save bar (#2138, PM-4): there only while something is
 * edited, saving, unconfirmed, just saved or refused; counting the seconds
 * while saving; and a save whose answer was lost unconfirmed until something
 * shows its outcome, never called failed (L766).
 *
 * The clock is set, never waited on (L290): Date and the interval timers are
 * faked, and the probe answers are queued, so "5 s later" is a timer advance.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'

vi.mock('@/lib/api', () => ({
  api: {
    partners: { usage: () => Promise.resolve({ bid_group: [], partner_bid: [], latency_gate: [] }), versions: vi.fn(), workflowValues: () => Promise.resolve({ partner: { id: 'p', slug: 'p' }, values: [], searched: { workflows: 0, with_constants_node: 0 } }) },
    partnerUuids: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    partnerBidConfigs: { list: vi.fn() },
    buyerProfiles: { get: vi.fn() },
  },
}))

import PartnerForm from '../PartnerForm'
import { UNCONFIRMED_DISCARD_GAVE_UP } from '../save-bar-text'
import { api } from '@/lib/api'
import type { Partner, PartnerPageVersions } from '@/lib/api'

const partner: Partner = {
  id: 'p1', organization_id: 'org-1', name: 'M1', slug: 'm1', api_endpoint: null, cf_secret_key: null, daily_cap: null, min_bid: null,
  bid_formula: null, bid_resolver_type: 'formula', bid_resolver_config: {}, outbound_field_mapping: null,
  bid_comparison_source: 'auto', extra_extraction: null, last_probe_response: null, dedup_endpoint: null, response_classification: null,
  alert_config: null, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 300, circuit_enabled: true,
  confirmation_window_ms: null, is_active: true, priority: 0, sell_off_offer_title: null, sell_off_offer_details: null, click_url: null,
  sub_account_min_bids: null, partner_type: 'source', created_at: '', updated_at: '2026-10-15T14:00:00Z', updated_by_email: null, updated_by_name: null,
  version: 3,
}

const versions = (lastSaveId: string | null, partnerVersion = 3): PartnerPageVersions => ({ partnerId: 'p1', partnerVersion, profileVersion: 0, lastSaveId, profileLastSaveId: null, latestChange: null, newest: { partner: null, profile: null } })
const bar = () => document.querySelector('[data-save-bar]') as HTMLElement | null
/** Let queued promises settle and effects run, with the clock where it is. */
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.mocked(api.partnerUuids.list).mockResolvedValue([])
  vi.mocked(api.partnerBidConfigs.list).mockResolvedValue([])
  vi.mocked(api.partners.versions).mockResolvedValue(versions(null))
})
afterEach(() => vi.useRealTimers())

async function renderRenamed(onSave: Mock) {
  render(<PartnerForm partner={partner} onSave={onSave} onCancel={vi.fn()} />)
  await settle()
  fireEvent.click(screen.getByRole('tab', { name: 'Partner' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'M1 renamed' } })
}

describe('the bar appears only when something is edited (PM-4)', () => {
  it('is absent on a clean page, names the change once edited, and Discard changes puts it back and goes', async () => {
    render(<PartnerForm partner={partner} onSave={vi.fn()} onCancel={vi.fn()} />)
    await settle()
    expect(bar()).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Partner' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'M1 renamed' } })
    expect(bar()).toHaveTextContent('1 unsaved change: Name')
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(screen.getByLabelText('Name')).toHaveValue('M1')
    expect(bar()).toBeNull()
  })

  it('a new partner has the bar from the start, with Cancel and Create partner', async () => {
    render(<PartnerForm onSave={vi.fn()} onCancel={vi.fn()} />)
    await settle()
    expect(bar()).toHaveTextContent('New partner, not created yet')
    expect(screen.getByRole('button', { name: 'Create partner' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Acme' } })
    expect(screen.getByRole('button', { name: 'Create partner' })).toBeEnabled()
  })
})

describe('saving, and a save whose answer was lost (L766)', () => {
  it('counts the seconds while saving, then Saved with Undo, which goes with the Undo', async () => {
    let land!: (v: unknown) => void
    const onSave = vi.fn().mockImplementation(() => new Promise((res) => { land = res }))
    await renderRenamed(onSave)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await settle()
    expect(bar()).toHaveTextContent('Saving, 0 seconds')
    await advance(2_000)
    expect(bar()).toHaveTextContent('Saving, 2 seconds')
    await act(async () => { land({ partner: { ...partner, name: 'M1 renamed', version: 4 }, profile: null, copyWarning: null }) })
    await settle()
    expect(bar()).toHaveTextContent(/^Partner saved\./)
    expect(screen.getByRole('button', { name: 'Undo, 5' })).toBeInTheDocument()
    // The countdown renders each second, so the clock moves a second at a time.
    for (let s = 4; s >= 1; s--) {
      await advance(1_000)
      expect(screen.getByRole('button', { name: `Undo, ${s}` })).toBeInTheDocument()
    }
    await advance(1_000)
    expect(bar()).toBeNull()
  })

  it('a request that got no answer at 30 s is not confirmed yet, checking, never failed', async () => {
    let lose!: (e: unknown) => void
    const onSave = vi.fn().mockImplementation(() => new Promise((_res, rej) => { lose = rej }))
    await renderRenamed(onSave)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await advance(29_000)
    expect(bar()).toHaveTextContent('Saving, 29 seconds')
    // The API client aborts the request at 30 s: a TimeoutError carries no status.
    await advance(1_000)
    await act(async () => { lose(Object.assign(new Error('Timed out after 30s.'), { name: 'TimeoutError', timedOut: true })) })
    await settle()
    expect(bar()).toHaveTextContent('Not confirmed yet, checking.')
    expect(bar()).not.toHaveTextContent(/fail|Nothing saved/i)
  })

  it('the response lost and the save committing 5 s after the first read back ends Saved, with Undo at the version it made', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await renderRenamed(onSave)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await settle()
    const saveId = onSave.mock.calls[0][3].save_id as string
    // The first read back: not landed yet.
    expect(api.partners.versions).toHaveBeenCalledTimes(1)
    expect(bar()).toHaveTextContent('Not confirmed yet, checking.')
    vi.mocked(api.partners.versions).mockResolvedValue(versions(saveId, 4))
    await advance(5_000)
    expect(api.partners.versions).toHaveBeenCalledTimes(2)
    expect(bar()).toHaveTextContent(/^Partner saved\./)
    // Undo is the inverse at the version the landed save made.
    onSave.mockResolvedValueOnce({ partner: { ...partner, version: 5 }, profile: null, copyWarning: null })
    fireEvent.click(screen.getByRole('button', { name: /^Undo/ }))
    await settle()
    expect(onSave.mock.calls[1][0]).toEqual({ name: 'M1' })
    expect(onSave.mock.calls[1][3].expected_partner_version).toBe(4)
  })

  it('lost before it committed, with no evidence, it ends unconfirmed and is never shown Saved', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await renderRenamed(onSave)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await settle()
    // Someone else's save is not evidence of this one.
    vi.mocked(api.partners.versions).mockResolvedValue(versions('f0f0f0f0-0000-4000-8000-000000000001', 4))
    await advance(119_000)
    expect(bar()).toHaveTextContent('Not confirmed yet, checking.')
    await advance(1_000)
    expect(bar()).toHaveTextContent('Still not confirmed. It may have saved. Reload to see what is stored.')
    expect(bar()).not.toHaveTextContent(/fail|Partner saved/i)
    // It stops asking on a timer after two minutes; focus asks once more.
    const asked = vi.mocked(api.partners.versions).mock.calls.length
    await advance(60_000)
    expect(vi.mocked(api.partners.versions).mock.calls.length).toBe(asked)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await settle()
    expect(vi.mocked(api.partners.versions).mock.calls.length).toBe(asked + 1)
    expect(screen.queryByText(/^Partner saved/)).toBeNull()
  })

  it('once it has stopped checking, Discard is offered again, saying the save may have landed, and puts the page back (L665)', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await renderRenamed(onSave)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await settle()
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled()
    await advance(120_000)
    const discard = screen.getByRole('button', { name: 'Discard changes' })
    expect(discard).toBeEnabled()
    expect(document.getElementById(discard.getAttribute('aria-describedby') ?? '')).toHaveTextContent(UNCONFIRMED_DISCARD_GAVE_UP)
    // The leave dialog offers Discard again too, saying the same.
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate', { state: null })) })
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent(UNCONFIRMED_DISCARD_GAVE_UP)
    expect(within(dialog).getByRole('button', { name: 'Discard and go back' })).toBeEnabled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(screen.getByLabelText('Name')).toHaveValue('M1')
    expect(bar()).toBeNull()
  })

  it('Discard is disabled while unconfirmed, saying why, and Try again resends the same save id', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({ partner: { ...partner, name: 'M1 renamed', version: 4 }, profile: null, copyWarning: null })
    await renderRenamed(onSave)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await settle()
    const discard = screen.getByRole('button', { name: 'Discard changes' })
    expect(discard).toBeDisabled()
    expect(document.getElementById(discard.getAttribute('aria-describedby') ?? '')).toHaveTextContent('Your last save may still land. Wait for it to be confirmed before discarding.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(onSave.mock.calls[1][3].save_id).toBe(onSave.mock.calls[0][3].save_id)
    expect(bar()).toHaveTextContent(/^Partner saved\./)
  })

  it('Try again after a further edit saves what is on screen now, under a new save id, never the earlier press alone', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({ partner: { ...partner, name: 'M1 again', version: 4 }, profile: null, copyWarning: null })
    await renderRenamed(onSave)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await settle()
    expect(bar()).toHaveTextContent('Not confirmed yet, checking.')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'M1 again' } })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(onSave.mock.calls[1][0]).toEqual({ name: 'M1 again' })
    expect(onSave.mock.calls[1][3].save_id).not.toBe(onSave.mock.calls[0][3].save_id)
  })

  it('an Undo whose answer was lost and which the probe finds landed hands the page the row as the Undo left it', async () => {
    const onSave = vi.fn()
      .mockResolvedValueOnce({ partner: { ...partner, name: 'M1 renamed', version: 4 }, profile: null, copyWarning: null })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const onSaveConfirmed = vi.fn()
    render(<PartnerForm partner={partner} onSave={onSave} onCancel={vi.fn()} onSaveConfirmed={onSaveConfirmed} />)
    await settle()
    fireEvent.click(screen.getByRole('tab', { name: 'Partner' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'M1 renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /^Undo/ }))
    await settle()
    const undoId = onSave.mock.calls[1][3].save_id as string
    vi.mocked(api.partners.versions).mockResolvedValue(versions(undoId, 5))
    await advance(5_000)
    expect(bar()).toHaveTextContent(/^Undone\./)
    expect(onSaveConfirmed).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1', name: 'M1', version: 5 }))
    expect(screen.getByLabelText('Name')).toHaveValue('M1')
  })

  it('a save not yet confirmed arms the browser\'s leave warning even with nothing on screen unsaved', async () => {
    // An Undo whose answer was lost: the page shows what is stored, so nothing is dirty, yet the outcome is unknown.
    const onSave = vi.fn()
      .mockResolvedValueOnce({ partner: { ...partner, name: 'M1 renamed', version: 4 }, profile: null, copyWarning: null })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await renderRenamed(onSave)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await settle()
    const unload = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented }
    expect(unload()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /^Undo/ }))
    await settle()
    expect(bar()).toHaveTextContent('Not confirmed yet, checking.')
    expect(screen.getByLabelText('Name')).toHaveValue('M1 renamed')
    expect(unload()).toBe(true)
  })
})
