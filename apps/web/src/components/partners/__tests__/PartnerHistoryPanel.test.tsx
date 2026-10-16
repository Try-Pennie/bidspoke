/**
 * The History tab (#2141): every change to a partner, by day, with the time
 * and who made it; one error state for any failed read, never a partial list;
 * an incomplete answer said as such; a path nothing names shown and counted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLayoutEffect } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/api', () => ({ api: { partners: { history: vi.fn() } } }))

import { api, type Partner, type PartnerHistory, type HistoryEntry } from '@/lib/api'
import { PartnerHistoryPanel } from '../PartnerHistoryPanel'

const PARTNER = { id: 'p1', name: 'Liberty1', slug: 'liberty1' } as unknown as Partner
const B = { kind: 'person' as const, userId: '00000000-0000-4000-8000-000000000002', name: 'Editor B', via: null }
const A = { kind: 'person' as const, userId: '00000000-0000-4000-8000-000000000001', name: 'Editor A', via: null }

function entry(over: Partial<HistoryEntry>): HistoryEntry {
  return { key: 'audit:x', source: 'audit_log', at: '2026-10-14T20:52:21Z', entityType: 'buyer_profile', entityId: 'p1', action: 'updated', editor: B, editorLabel: 'Editor B', changes: {}, matrix: null, ...over }
}

const LIBERTY: PartnerHistory = {
  partnerId: 'p1', complete: true, completeSince: null,
  entries: [
    entry({ key: 'audit:1', at: '2026-10-14T20:52:21Z', editor: A, editorLabel: 'Editor A', changes: { loan_amount_min: { new: 10000, old: 2500 } } }),
    entry({ key: 'audit:2', at: '2026-10-14T19:45:18Z', changes: { is_enabled: { new: true, old: false } } }),
    entry({ key: 'audit:3', at: '2026-09-29T16:47:00Z', entityType: 'partner_config', changes: { click_url: { new: 'https://trypennie.com/portal/liberty/{prospect_id}', old: 'https://trypennie.com/portal/libertyone/{prospect_id}' } } }),
  ],
}

const NOW = Date.parse('2026-10-15T16:00:00Z')
const clock = () => NOW

beforeEach(() => {
  vi.mocked(api.partners.history).mockReset()
})
afterEach(() => vi.restoreAllMocks())

describe('PartnerHistoryPanel (#2141)', () => {
  it('reads the history only once the tab is shown, then lists each change under its Eastern day with its time and editor', async () => {
    vi.mocked(api.partners.history).mockResolvedValue(LIBERTY)
    const { rerender } = render(<PartnerHistoryPanel partner={PARTNER} shown={false} clock={clock} />)
    expect(api.partners.history).not.toHaveBeenCalled()
    rerender(<PartnerHistoryPanel partner={PARTNER} shown clock={clock} />)
    await screen.findByRole('heading', { name: 'Yesterday' })
    expect(api.partners.history).toHaveBeenCalledWith('p1')
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Yesterday', 'Tue, Sep 29'])
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('4:52 PM ET')
    expect(items[0]).toHaveTextContent('Editor A')
    expect(items[1]).toHaveTextContent('Editor B')
    // Old struck through, new in bold, each named for a screen reader too.
    const old = within(items[0]).getByText('$2,500.00')
    expect(old.tagName).toBe('DEL')
    expect(within(items[0]).getByText('$10,000.00').tagName).toBe('STRONG')
    expect(items[0]).toHaveTextContent(/Loan amount minimum\s*from \$2,500\.00\s*\u2192\s*to \$10,000\.00/)
    expect(items[2]).toHaveTextContent('Click URL')
    // Shown again, the tab does not read again.
    rerender(<PartnerHistoryPanel partner={PARTNER} shown={false} clock={clock} />)
    rerender(<PartnerHistoryPanel partner={PARTNER} shown clock={clock} />)
    expect(api.partners.history).toHaveBeenCalledTimes(1)
  })

  it('any failed read is the one error state with Try again, never a partial list, and Try again reads again', async () => {
    vi.mocked(api.partners.history).mockRejectedValueOnce(Object.assign(new Error('History could not be loaded: the users read failed.'), { status: 500 }))
    render(<PartnerHistoryPanel partner={PARTNER} shown clock={clock} />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load history. Try again.')
    expect(screen.queryByRole('listitem')).toBeNull()
    vi.mocked(api.partners.history).mockResolvedValueOnce(LIBERTY)
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await screen.findByRole('heading', { name: 'Yesterday' })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(api.partners.history).toHaveBeenCalledTimes(2)
  })

  it('says it is reading while it reads', async () => {
    vi.mocked(api.partners.history).mockReturnValue(new Promise(() => {}))
    render(<PartnerHistoryPanel partner={PARTNER} shown clock={clock} />)
    expect(screen.getByRole('status')).toHaveTextContent('Reading the history')
  })

  it('an incomplete answer says how far back it is complete, after the last change it lists', async () => {
    vi.mocked(api.partners.history).mockResolvedValue({ ...LIBERTY, complete: false, completeSince: '2026-09-29T16:00:00Z' })
    render(<PartnerHistoryPanel partner={PARTNER} shown clock={clock} />)
    expect(await screen.findByText('History is complete back to Sep 29, 12:00 PM ET; older changes are not listed.')).toBeVisible()
  })

  it('a partner with no recorded change says so', async () => {
    vi.mocked(api.partners.history).mockResolvedValue({ partnerId: 'p1', entries: [], complete: true, completeSince: null })
    render(<PartnerHistoryPanel partner={PARTNER} shown clock={clock} />)
    expect(await screen.findByText('No change to Liberty1 is recorded.')).toBeVisible()
  })

  it('a path nothing names is shown under its raw name and logged once with its count', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(api.partners.history).mockResolvedValue({ ...LIBERTY, entries: [entry({ changes: { 'mystery.path': { old: 1, new: 2 }, 'other.path': { old: null, new: 3 } } })] })
    render(<PartnerHistoryPanel partner={PARTNER} shown clock={clock} />)
    expect(await screen.findByText('mystery.path')).toBeVisible()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[partner-history] history_unregistered_path', { partnerId: 'p1', count: 2, paths: ['mystery.path', 'other.path'] })
  })

  it('a change with no actor shows the pickup note only while bidding may still be catching up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let now = Date.parse('2026-10-15T16:01:00Z')
      const direct = entry({ at: '2026-10-15T16:00:00Z', entityType: 'partner_config', editor: { kind: 'direct' }, editorLabel: 'Changed directly in the database', changes: { _source: 'direct_sql', daily_cap: { old: 40, new: 50 } } })
      vi.mocked(api.partners.history).mockResolvedValue({ ...LIBERTY, entries: [direct] })
      render(<PartnerHistoryPanel partner={PARTNER} shown clock={() => now} />)
      await vi.waitFor(() => expect(screen.getByText('Changed directly in the database')).toBeInTheDocument())
      expect(screen.getByText('Bidding picks this up within about 8 minutes of that time while the database is reachable.')).toBeInTheDocument()
      now = Date.parse('2026-10-15T16:08:01Z')
      await act(async () => { vi.advanceTimersByTime(7 * 60_000 + 1000) })
      expect(screen.queryByText(/Bidding picks this up/)).toBeNull()
      expect(screen.getByText('Changed directly in the database')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a newly selected partner never paints the previous partner\'s history, not even for the frame before its read starts', async () => {
    vi.mocked(api.partners.history).mockResolvedValue(LIBERTY)
    const painted: string[] = []
    // A layout effect runs after the DOM is written and before the panel's own
    // effects, so it sees exactly what the first frame for the new partner shows.
    function Probe({ partner }: { partner: Partner }) {
      useLayoutEffect(() => { painted.push(document.body.textContent ?? '') })
      return <PartnerHistoryPanel partner={partner} shown clock={clock} />
    }
    const { rerender } = render(<Probe partner={PARTNER} />)
    await screen.findByRole('heading', { name: 'Yesterday' })
    vi.mocked(api.partners.history).mockReturnValue(new Promise(() => {}))
    painted.length = 0
    rerender(<Probe partner={{ ...PARTNER, id: 'p2', name: 'Tripoint' } as Partner} />)
    expect(painted[0]).not.toContain('Loan amount minimum')
    expect(painted[0]).toContain('Reading the history')
  })

  it('a newly selected partner reads its own history', async () => {
    vi.mocked(api.partners.history).mockResolvedValue(LIBERTY)
    const { rerender } = render(<PartnerHistoryPanel partner={PARTNER} shown clock={clock} />)
    await screen.findByRole('heading', { name: 'Yesterday' })
    vi.mocked(api.partners.history).mockResolvedValue({ partnerId: 'p2', entries: [], complete: true, completeSince: null })
    rerender(<PartnerHistoryPanel partner={{ ...PARTNER, id: 'p2', name: 'Tripoint' } as Partner} shown clock={clock} />)
    await waitFor(() => expect(screen.getByText('No change to Tripoint is recorded.')).toBeVisible())
    expect(api.partners.history).toHaveBeenLastCalledWith('p2')
  })
})
