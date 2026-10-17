/**
 * The partner form's versioned save (#2132, part of #2114).
 *
 * A save sends the version the page was edited from, a save id minted per
 * press, and only the fields the person changed, so it can no longer put back
 * a newer save someone else made. A stale save is refused and the edits stay
 * on screen, merged with theirs field by field (#2134). A page opened before this release is told
 * to reload. A stored copy that could not be refreshed is shown beside Saved,
 * never as an error, and the pickup sentence reads BIDDING_PICKUP.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('@/lib/api', () => ({
  api: {
    partners: { usage: () => Promise.resolve({ bid_group: [], partner_bid: [], latency_gate: [] }), versions: vi.fn(), workflowValues: () => Promise.resolve({ partner: { id: 'p', slug: 'p' }, values: [], searched: { workflows: 0, with_constants_node: 0 } }) },
    partnerUuids: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    partnerBidConfigs: { list: vi.fn() },
    buyerProfiles: { get: vi.fn(), usage: vi.fn() },
    buyerSales: { list: vi.fn(), settle: vi.fn() },
  },
}))

import PartnerForm from '../PartnerForm'
import { api } from '@/lib/api'
import type { Partner, PartnerUuid } from '@/lib/api'
import { pickupSentence } from '@/lib/bidding-pickup'

const partner: Partner = {
  id: 'p1', organization_id: 'org-1', name: 'M1', slug: 'm1', api_endpoint: null, cf_secret_key: null, daily_cap: null, min_bid: null,
  bid_formula: null, bid_resolver_type: 'api', bid_resolver_config: {}, outbound_field_mapping: null,
  bid_comparison_source: 'auto', extra_extraction: null, last_probe_response: null, dedup_endpoint: null, response_classification: null,
  alert_config: null, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 300, circuit_enabled: true,
  confirmation_window_ms: null, is_active: true, priority: 0, sell_off_offer_title: null, sell_off_offer_details: null, click_url: null,
  sub_account_min_bids: null, partner_type: 'source', created_at: '', updated_at: '2026-10-15T14:00:00Z', updated_by_email: null, updated_by_name: null,
  version: 3,
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const uuid: PartnerUuid = { id: 'uuid-1', partner_slug: 'm1', uuid: '11111111-1111-1111-1111-111111111111', created_at: '' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.partnerUuids.list).mockResolvedValue([uuid])
  vi.mocked(api.partnerBidConfigs.list).mockResolvedValue([])
  vi.mocked(api.buyerProfiles.get).mockResolvedValue({ profile: null, accept_signals: [], other_sellers: [] })
  vi.mocked(api.buyerProfiles.usage).mockRejectedValue(Object.assign(new Error('usage_unavailable'), { status: 503 }))
  vi.mocked(api.buyerSales.list).mockResolvedValue({ entries: [], total: 0, page: 1, limit: 100 })
  // The probe an unconfirmed save asks (#2138): nothing of this page's has landed.
  vi.mocked(api.partners.versions).mockResolvedValue({ partnerId: 'p1', partnerVersion: 3, profileVersion: 0, lastSaveId: null, profileLastSaveId: null, latestChange: null, newest: { partner: null, profile: null } })
})

function saved(over: Partial<Partner> = {}, copyWarning: string | null = null) {
  return { partner: { ...partner, version: 4, ...over }, profile: null, copyWarning }
}

function renderForm(onSave = vi.fn().mockResolvedValue(saved())) {
  render(<PartnerForm partner={partner} onSave={onSave} onCancel={vi.fn()} />)
  return onSave
}

const rename = (value = 'M1 renamed') => fireEvent.change(screen.getByDisplayValue(/^M1/), { target: { value } })
// The save bar's button that saves, whatever it reads now (#2138): Save changes, or Try again after no answer or a failure.
const save = () => fireEvent.click(screen.getByRole('button', { name: /^(Save changes|Try again)$/ }))
const stale = (over: Record<string, unknown>) => Object.assign(new Error('stale_version'), {
  status: 409,
  body: { error: 'stale_version', partner: { ...partner, name: 'M1 (theirs)', version: 5 }, profile: null, partner_version: 5, profile_version: 0, last_save_id: 'f0f0f0f0-0000-4000-8000-000000000001', changed_by_name: 'Brian Nelms', changed_at: '2026-10-15T18:02:00Z', ...over },
})

describe('a versioned save of only what changed (#2132)', () => {
  it('sends the version edited from, a save id, and only the edited field', async () => {
    const onSave = renderForm()
    rename()
    save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const [body, id, pending, versioning] = onSave.mock.calls[0]
    expect(body).toEqual({ name: 'M1 renamed' })
    expect(id).toBe('p1')
    expect(pending).toBeUndefined()
    expect(versioning.expected_partner_version).toBe(3)
    expect(versioning.save_id).toMatch(UUID_RE)
    // A source partner never reads a profile, so this save neither writes one nor is compared on one (#2133).
    expect(versioning.profile).toBeNull()
    expect(versioning.expected_profile_version).toBeNull()
  })

  it('never sends a field the person did not touch', async () => {
    const onSave = renderForm()
    rename()
    save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(Object.keys(onSave.mock.calls[0][0])).toEqual(['name'])
  })

  it('the next save names the version the last one produced, and mints a new save id', async () => {
    const onSave = renderForm()
    rename('M1 a')
    save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    rename('M1 b')
    save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    expect(onSave.mock.calls[1][0]).toEqual({ name: 'M1 b' })
    expect(onSave.mock.calls[1][3].expected_partner_version).toBe(4)
    expect(onSave.mock.calls[1][3].save_id).not.toBe(onSave.mock.calls[0][3].save_id)
  })

  it('a press retried after no answer reuses its save id', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(saved())
    renderForm(onSave)
    rename()
    save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    expect(onSave.mock.calls[1][3].save_id).toBe(onSave.mock.calls[0][3].save_id)
  })

  it('a 409 carrying this press\'s own save id is its landed save, shown as Saved', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'))
    renderForm(onSave)
    rename()
    save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const id = () => onSave.mock.calls[0][3].save_id
    onSave.mockImplementationOnce(async () => { throw stale({ last_save_id: id(), partner: { ...partner, name: 'M1 renamed', version: 4 }, partner_version: 4 }) })
    save()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/^Partner saved\./))
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('a 409 from someone else keeps the draft and, on Keep editing, names who saved and when, in ET', async () => {
    const onSave = vi.fn().mockRejectedValue(stale({}))
    renderForm(onSave)
    rename()
    save()
    const dialog = await screen.findByRole('dialog')
    // No bar behind the merge dialog (#2322): the design draws none.
    expect(document.querySelector('[data-save-bar]')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
    expect(await screen.findByText('Not saved. Brian Nelms saved this partner at Oct 15, 2:02 PM ET. Your changes are still here.')).toBeInTheDocument()
    expect(screen.getByDisplayValue('M1 renamed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeInTheDocument()
  })

  it('a 409 from someone else asks about a field both changed, in the merge dialog', async () => {
    renderForm(vi.fn().mockRejectedValue(stale({})))
    rename()
    save()
    const dialog = await screen.findByRole('dialog', { name: 'Brian Nelms saved this partner while you were editing' })
    expect(dialog).toHaveTextContent("yours M1 renamed, Brian's M1 (theirs)")
  })

  it('a 409 whose changes do not touch yours puts theirs on screen, names them, and saves yours only on the next press, at their version', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(stale({ partner: { ...partner, is_active: false, version: 5 } })).mockResolvedValueOnce(saved({ name: 'M1 renamed', is_active: false, version: 6 }))
    renderForm(onSave)
    rename()
    save()
    expect(await screen.findByText('Not saved yet. Brian Nelms also saved this partner; their changes to Active were kept. Press Save changes to save yours.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
    // Active reads On or Off (#2323).
    expect(screen.getByRole('switch', { name: 'Active', hidden: true })).toHaveAttribute('aria-checked', 'false')
    expect(onSave).toHaveBeenCalledTimes(1)
    save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    expect(onSave.mock.calls[1][0]).toEqual({ name: 'M1 renamed' })
    expect(onSave.mock.calls[1][3].expected_partner_version).toBe(5)
    expect(onSave.mock.calls[1][3].save_id).not.toBe(onSave.mock.calls[0][3].save_id)
  })

  it('a 409 from someone who made the same change leaves nothing to save', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(stale({ partner: { ...partner, name: 'M1 renamed', version: 5 } }))
    renderForm(onSave)
    rename()
    save()
    expect(await screen.findByText('Brian Nelms saved the same changes, so nothing is left to save.')).toBeInTheDocument()
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
  })

  describe('saving a merge (#2134)', () => {
    // They renamed it and switched it off; I renamed it too. Name is the question.
    const theirs = () => stale({ partner: { ...partner, name: 'M1 (theirs)', is_active: false, version: 5 } })
    const keepMineAndSave = async () => {
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(within(dialog).getByRole('radio', { name: 'Keep yours' }))
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save both' }))
    }

    it('sends only what is still mine, measured against their save, at their version', async () => {
      const onSave = vi.fn().mockRejectedValueOnce(theirs()).mockResolvedValueOnce(saved({ name: 'M1 renamed', is_active: false, version: 6 }))
      renderForm(onSave)
      rename()
      save()
      await keepMineAndSave()
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
      // Their switch off is the base now, so it is not sent back as a change of mine.
      expect(onSave.mock.calls[1][0]).toEqual({ name: 'M1 renamed' })
      expect(onSave.mock.calls[1][3].expected_partner_version).toBe(5)
    })

    it('a merged save that got no answer is resent under the same save id, so it can recognise itself', async () => {
      const onSave = vi.fn().mockRejectedValueOnce(theirs()).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(saved({ name: 'M1 renamed', is_active: false, version: 6 }))
      renderForm(onSave)
      rename()
      save()
      await keepMineAndSave()
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
      // No answer is not a failure (L766): the bar says it is not confirmed yet.
      await screen.findByText('Not confirmed yet, checking.')
      save()
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(3))
      expect(onSave.mock.calls[2][3].save_id).toBe(onSave.mock.calls[1][3].save_id)
      expect(onSave.mock.calls[1][3].save_id).not.toBe(onSave.mock.calls[0][3].save_id)
    })

    it('an answer given to a value the person has since changed is asked again', async () => {
      const onSave = vi.fn().mockRejectedValue(theirs())
      renderForm(onSave)
      rename()
      save()
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(within(dialog).getByRole('radio', { name: /^Use / }))
      fireEvent.keyDown(dialog, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      rename('M1 renamed again')
      save()
      const again = await screen.findByRole('dialog')
      // Use theirs was an answer to the old value, so the new one starts at Keep yours (#2322).
      expect(within(again).getByRole('radio', { name: 'Keep yours' })).toHaveAttribute('aria-checked', 'true')
      expect(within(again).getByRole('radio', { name: /^Use / })).toHaveAttribute('aria-checked', 'false')
    })
  })

  it('a 409 with no named editor says the change came from outside the page', async () => {
    const onSave = vi.fn().mockRejectedValue(stale({ changed_by_name: null }))
    renderForm(onSave)
    rename()
    save()
    // The bar says it once the merge dialog is closed (#2322: no bar behind the dialog).
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep editing' }))
    expect(await screen.findByText('Not saved. This partner was changed at Oct 15, 2:02 PM ET, outside the partners page. Your changes are still here.')).toBeInTheDocument()
  })

  it('a 428 from a page older than the release shows the server\'s reload sentence and keeps the edits', async () => {
    const message = 'This page was opened before an update to how partners are saved, so this save was not made. Your changes are still on screen. Copy them and reload.'
    const onSave = vi.fn().mockRejectedValue(Object.assign(new Error('reload_required'), { status: 428, body: { error: 'reload_required', message } }))
    renderForm(onSave)
    rename()
    save()
    expect(await screen.findByText(`Nothing saved: ${message}`)).toBeInTheDocument()
    expect(screen.getByDisplayValue('M1 renamed')).toBeInTheDocument()
  })

  it('a stored copy warning is shown beside Saved in its shared words, never as an error', async () => {
    const WARNING = 'The change was saved and recorded, but a stored copy of the old version could not be refreshed.'
    renderForm(vi.fn().mockResolvedValue(saved({ name: 'M1 renamed' }, WARNING)))
    rename()
    save()
    await waitFor(() => expect(screen.getByText(WARNING)).toBeInTheDocument())
    expect(screen.getAllByRole('status').map((s) => s.textContent).join(' ')).toMatch(/Partner saved\./)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText(WARNING).closest('[role="status"]')).not.toBeNull()
  })

  it('says when bidding picks the change up, from the one constant', async () => {
    renderForm()
    rename()
    save()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(`Partner saved. ${pickupSentence()}`))
  })

  it('an edit that changes nothing stored (a blank floor row) saves nothing and no longer reads as unsaved', async () => {
    const onSave = vi.fn()
    render(<PartnerForm partner={{ ...partner, partner_type: 'buyer' }} onSave={onSave} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Add row/, hidden: true }))
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument()
    save()
    await screen.findByText('Nothing to save.')
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
  })

  it('a partner with nothing changed offers no Save at all, so nothing can be written (#2138)', async () => {
    const onSave = renderForm()
    await screen.findByRole('tablist')
    expect(screen.queryByRole('button', { name: /^Save changes$/ })).toBeNull()
    expect(document.querySelector('[data-save-bar]')).toBeNull()
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe('Undo is a versioned save of the inverse (#2132)', () => {
  it('sends each saved field back to its value before, at the version the save produced, and says nothing about a profile when none was saved', async () => {
    const onSave = renderForm()
    rename()
    save()
    const undo = await screen.findByRole('button', { name: /^Undo/ })
    expect(screen.queryByText(/buyer profile/i)).not.toBeInTheDocument()
    fireEvent.click(undo)
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    expect(onSave.mock.calls[1][0]).toEqual({ name: 'M1' })
    expect(onSave.mock.calls[1][3].expected_partner_version).toBe(4)
  })

  it('an Undo refused as stale names who saved, overwrites nothing, and leaves the screen showing what is stored', async () => {
    const onSave = vi.fn().mockResolvedValueOnce(saved({ name: 'M1 renamed' })).mockRejectedValueOnce(stale({}))
    renderForm(onSave)
    rename()
    save()
    fireEvent.click(await screen.findByRole('button', { name: /^Undo/ }))
    expect(await screen.findByText('Undo not made. Brian Nelms saved this partner at Oct 15, 2:02 PM ET.')).toBeInTheDocument()
    expect(onSave).toHaveBeenCalledTimes(2)
    // The save that landed is still what the form shows, so nothing reads as unsaved.
    expect(screen.getByDisplayValue('M1 renamed')).toBeInTheDocument()
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
  })
})

describe('a failed read is its own state (L10)', () => {
  it('sub-account IDs that could not be read say so, with a retry that reads again', async () => {
    vi.mocked(api.partnerUuids.list).mockRejectedValueOnce(new Error('503'))
    renderForm()
    expect(await screen.findByText('Could not load sub-account IDs. Try again.')).toBeInTheDocument()
    expect(screen.queryByText(uuid.uuid)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText(uuid.uuid)).toBeInTheDocument()
    expect(screen.queryByText('Could not load sub-account IDs. Try again.')).not.toBeInTheDocument()
  })

  it('bid matrices that could not be read say so, with a retry', async () => {
    vi.mocked(api.partnerBidConfigs.list).mockRejectedValueOnce(new Error('503'))
    render(<PartnerForm partner={{ ...partner, partner_type: 'buyer', bid_resolver_type: 'matrix' }} onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByText('Could not load bid matrices. Try again.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again', hidden: true }))
    await waitFor(() => expect(api.partnerBidConfigs.list).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('Could not load bid matrices. Try again.')).not.toBeInTheDocument())
  })
})
