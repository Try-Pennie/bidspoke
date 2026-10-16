/**
 * Leaving a partner with an unsaved change (#2138, PM-5): the page's own
 * dialog, from each of the three in app ways away (a list click, a sidebar
 * link, browser back) and from sign out, with each of its three buttons.
 * Escape and a click outside keep editing; only Discard discards; Save and
 * open it goes on only once the save is confirmed, and stays on a refusal, a
 * 409 that opens the merge dialog, or a save not yet confirmed.
 *
 * The real page, form, sidebar and leave guard; only the Worker API, the App
 * Router and the Supabase client are stood in for.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

const push = vi.fn()
vi.mock('next/navigation', () => ({
  usePathname: () => '/partners',
  useRouter: () => ({ push }),
  useSearchParams: () => ({ get: () => null }),
}))
// A Link as the App Router draws it: a real anchor whose click navigates on the client.
vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className} onClick={(e) => { e.preventDefault(); push(href) }}>{children}</a>
  ),
}))
vi.mock('next/image', () => ({ default: (props: { alt: string }) => <span>{props.alt}</span> }))
const signOut = vi.fn().mockResolvedValue({})
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { signOut } }) }))
vi.mock('@/lib/api', () => ({
  api: {
    partners: { list: vi.fn(), savePage: vi.fn(), create: vi.fn(), delete: vi.fn(), usage: vi.fn(), versions: vi.fn() },
    partnerUuids: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    partnerBidConfigs: { list: vi.fn() },
    buyerProfiles: { get: vi.fn(), history: vi.fn() },
  },
}))

import PartnersPage from '../page'
import { api } from '@/lib/api'
import type { Partner } from '@/lib/api'

const row = (id: string, name: string): Partner => ({
  id, organization_id: 'org-1', name, slug: name.toLowerCase(), api_endpoint: null, cf_secret_key: null, daily_cap: null, min_bid: null,
  bid_formula: null, bid_resolver_type: 'formula', bid_resolver_config: {}, outbound_field_mapping: null,
  bid_comparison_source: 'auto', extra_extraction: null, last_probe_response: null, dedup_endpoint: null, response_classification: null,
  alert_config: null, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 300, circuit_enabled: true,
  confirmation_window_ms: null, is_active: true, priority: 0, sell_off_offer_title: null, sell_off_offer_details: null, click_url: null,
  sub_account_min_bids: null, partner_type: 'source', created_at: '', updated_at: '2026-10-15T14:00:00Z', updated_by_email: null, updated_by_name: null,
  version: 3,
})
const SOFI = row('s', 'Sofi')
const DOT = row('d', 'Dot818')

const saved = (name: string) => ({ partner: { ...SOFI, name, version: 4 }, profile: null, partner_version: 4, profile_version: 0 })

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/partners')
  vi.mocked(api.partners.list).mockResolvedValue([SOFI, DOT])
  vi.mocked(api.partners.usage).mockResolvedValue({ bid_group: [], partner_bid: [], latency_gate: [] })
  vi.mocked(api.partners.versions).mockResolvedValue({ partnerId: 's', partnerVersion: 3, profileVersion: 0, lastSaveId: null, profileLastSaveId: null, latestChange: null, newest: { partner: null, profile: null } })
  vi.mocked(api.partners.savePage).mockImplementation(async (_id, patch) => saved(String((patch as { name?: string }).name ?? 'Sofi')))
  vi.mocked(api.partnerUuids.list).mockResolvedValue([])
  vi.mocked(api.partnerBidConfigs.list).mockResolvedValue([])
})
afterEach(() => vi.restoreAllMocks())

/** Open Sofi and rename it, so the page has one unsaved change. */
async function dirtySofi() {
  render(<PartnersPage />)
  fireEvent.click(await screen.findByRole('button', { name: 'Sofi' }))
  fireEvent.click(await screen.findByRole('tab', { name: 'Partner' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sofi 2' } })
  expect(document.querySelector('[data-save-bar]')).toHaveTextContent('1 unsaved change: Name')
}

// Named as stored, as the settled design names it: the rename is the change.
const leaveDialog = () => screen.findByRole('alertdialog', { name: 'Leave Sofi with an unsaved change?' })

describe('from a list click (#2138, PM-5)', () => {
  it('asks in the page\'s own dialog, naming the change and the other partner', async () => {
    await dirtySofi()
    fireEvent.click(screen.getByRole('button', { name: 'Dot818' }))
    const dialog = await leaveDialog()
    expect(dialog).toHaveTextContent('You changed Name and have not saved it.')
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Keep editing', 'Discard and open Dot818', 'Save and open Dot818'])
  })

  it('Keep editing stays on the partner with the change', async () => {
    await dirtySofi()
    fireEvent.click(screen.getByRole('button', { name: 'Dot818' }))
    fireEvent.click(within(await leaveDialog()).getByRole('button', { name: 'Keep editing' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByLabelText('Name')).toHaveValue('Sofi 2')
    expect(api.partners.savePage).not.toHaveBeenCalled()
  })

  it('Discard and open it opens the other partner and saves nothing', async () => {
    await dirtySofi()
    fireEvent.click(screen.getByRole('button', { name: 'Dot818' }))
    fireEvent.click(within(await leaveDialog()).getByRole('button', { name: 'Discard and open Dot818' }))
    expect(await screen.findByRole('heading', { name: 'Dot818' })).toBeInTheDocument()
    expect(api.partners.savePage).not.toHaveBeenCalled()
  })

  it('Save and open it saves, then opens the other partner', async () => {
    await dirtySofi()
    fireEvent.click(screen.getByRole('button', { name: 'Dot818' }))
    fireEvent.click(within(await leaveDialog()).getByRole('button', { name: 'Save and open Dot818' }))
    expect(await screen.findByRole('heading', { name: 'Dot818' })).toBeInTheDocument()
    expect(api.partners.savePage).toHaveBeenCalledWith('s', { name: 'Sofi 2' }, expect.objectContaining({ expected_partner_version: 3 }))
  })

  it('Escape and a click outside keep editing; nothing is discarded', async () => {
    await dirtySofi()
    fireEvent.click(screen.getByRole('button', { name: 'Dot818' }))
    fireEvent.keyDown(await leaveDialog(), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Dot818' }))
    await leaveDialog()
    const scrim = document.querySelector('.dialog-overlay')!
    // Radix attaches its outside listener a task after opening: wait on the outcome, not a time.
    await waitFor(() => {
      fireEvent.pointerDown(scrim)
      fireEvent.pointerUp(scrim)
      fireEvent.click(scrim)
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
    expect(screen.getByLabelText('Name')).toHaveValue('Sofi 2')
    expect(screen.getByRole('heading', { name: 'Sofi 2' })).toBeInTheDocument()
  })

  it('Save and open it stays on the page, with the bar\'s message, when the save is refused (422)', async () => {
    vi.mocked(api.partners.savePage).mockRejectedValue(Object.assign(new Error('refused'), { status: 422, body: { error: 'x', message: 'The name is taken.' } }))
    await dirtySofi()
    fireEvent.click(screen.getByRole('button', { name: 'Dot818' }))
    fireEvent.click(within(await leaveDialog()).getByRole('button', { name: 'Save and open Dot818' }))
    expect(await screen.findByText('Nothing saved: The name is taken.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Sofi 2' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Dot818' })).toBeNull()
  })

  it('Save and open it stays on the page when someone else saved first (409), with the merge dialog open', async () => {
    vi.mocked(api.partners.savePage).mockRejectedValue(Object.assign(new Error('stale_version'), {
      status: 409,
      body: { error: 'stale_version', partner: { ...SOFI, name: 'Sofi (theirs)', version: 5 }, profile: null, partner_version: 5, profile_version: 0, last_save_id: 'f0f0f0f0-0000-4000-8000-000000000001', changed_by_name: 'Brian Nelms', changed_at: '2026-10-15T18:02:00Z' },
    }))
    await dirtySofi()
    fireEvent.click(screen.getByRole('button', { name: 'Dot818' }))
    fireEvent.click(within(await leaveDialog()).getByRole('button', { name: 'Save and open Dot818' }))
    expect(await screen.findByRole('dialog', { name: 'Brian Nelms saved this partner while you were editing' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Dot818', hidden: true })).toBeNull()
  })

  it('Save and open it stays on the page while the save is not confirmed, and Discard waits for it', async () => {
    vi.mocked(api.partners.savePage).mockRejectedValue(new TypeError('Failed to fetch'))
    await dirtySofi()
    fireEvent.click(screen.getByRole('button', { name: 'Dot818' }))
    fireEvent.click(within(await leaveDialog()).getByRole('button', { name: 'Save and open Dot818' }))
    expect(await screen.findByText('Not confirmed yet, checking.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Sofi 2' })).toBeInTheDocument()
    // Asked again while unconfirmed, Discard is refused with why.
    fireEvent.click(screen.getByRole('button', { name: 'Dot818' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Your last save may still land. Wait for it to be confirmed before discarding.')
    expect(within(dialog).getByRole('button', { name: 'Discard and open Dot818' })).toBeDisabled()
  })
})

describe('from a sidebar link (#2138, PM-5)', () => {
  it('names the page; Discard and open it follows the link, and Save and open it saves first', async () => {
    await dirtySofi()
    fireEvent.click(screen.getByRole('link', { name: 'Workflows' }))
    expect(push).not.toHaveBeenCalled()
    const dialog = await leaveDialog()
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Keep editing', 'Discard and open Workflows', 'Save and open Workflows'])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and open Workflows' }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/workflows'))
    expect(api.partners.savePage).toHaveBeenCalledTimes(1)
  })

  it('Discard and open it follows the link once and saves nothing', async () => {
    await dirtySofi()
    fireEvent.click(screen.getByRole('link', { name: 'Environment' }))
    fireEvent.click(within(await leaveDialog()).getByRole('button', { name: 'Discard and open Environment' }))
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith('/env')
    expect(api.partners.savePage).not.toHaveBeenCalled()
  })

  it('a cmd or ctrl click is not held: it opens a new tab, which loses nothing', async () => {
    await dirtySofi()
    fireEvent.click(screen.getByRole('link', { name: 'Workflows' }), { metaKey: true })
    fireEvent.click(screen.getByRole('link', { name: 'Workflows' }), { ctrlKey: true })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('from browser back (#2138, PM-5)', () => {
  it('asks; Discard and go back goes back past the sentinel, and Save and go back saves first', async () => {
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    await dirtySofi()
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
    let dialog = await leaveDialog()
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Keep editing', 'Discard and go back', 'Save and go back'])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(go).not.toHaveBeenCalled()
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
    dialog = await leaveDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and go back' }))
    await waitFor(() => expect(go).toHaveBeenCalledWith(-2))
    expect(api.partners.savePage).toHaveBeenCalledTimes(1)
  })

  it('Discard and go back saves nothing', async () => {
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    await dirtySofi()
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
    fireEvent.click(within(await leaveDialog()).getByRole('button', { name: 'Discard and go back' }))
    expect(go).toHaveBeenCalledWith(-2)
    expect(api.partners.savePage).not.toHaveBeenCalled()
  })
})

describe('sign out and an expired session (#2138, PM-5)', () => {
  it('sign out with a dirty draft opens the dialog and signs nobody out until the person says so', async () => {
    await dirtySofi()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    const dialog = await leaveDialog()
    expect(signOut).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard and sign out' }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/login'))
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('a 401 with a dirty draft keeps the draft and says to sign in again in a new tab', async () => {
    vi.mocked(api.partners.savePage).mockRejectedValue(Object.assign(new Error('Not authenticated'), { status: 401 }))
    await dirtySofi()
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText(/your session has expired\. Sign in again in a new tab/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('target', '_blank')
    expect(screen.getByLabelText('Name')).toHaveValue('Sofi 2')
  })
})
