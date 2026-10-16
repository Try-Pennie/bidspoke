/**
 * The partner delete box (#2140, PM-13): it knows before the press whether the
 * partner can be deleted, takes DELETE typed exactly, sends what it showed, and
 * shows the partner as it is now when the delete is refused.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PartnerDeleteCheck } from '@/lib/api'

vi.mock('@/lib/api', () => ({ api: { partners: { deleteCheck: vi.fn(), delete: vi.fn() } } }))
import { api } from '@/lib/api'
import { DELETE_CHECK_FAILED, PartnerDeleteBox } from '../PartnerDeleteBox'
import { consequenceSentence, secretSentence, workflowSentences } from '../delete-copy'

const PARTNER = { id: 'p-tp', name: 'Tripoint' }
const FP = { counts: { partner_uuid_map: 2 }, workflows: [{ id: 'w1', updated_at: '2026-10-15T12:00:00.123456+00:00' }] }
const clean = (over: Partial<PartnerDeleteCheck> = {}): PartnerDeleteCheck => ({
  partner: { id: 'p-tp', name: 'Tripoint', slug: 'tripoint', partner_type: 'buyer', is_active: true },
  blockers: [],
  removes: [
    { table: 'buyer_profiles', kind: 'deleted', rows: 1, noun: { one: 'buyer profile', many: 'buyer profiles' } },
    { table: 'bid_config_history', kind: 'deleted', rows: 4, noun: { one: 'matrix history entry', many: 'matrix history entries' } },
    { table: 'partner_uuid_map', kind: 'deleted', rows: 2, noun: { one: 'sub-account ID', many: 'sub-account IDs' } },
  ],
  workflows_naming_partner: [],
  workflows_reading_values: [],
  secret: { name: 'TRIPOINT_PROXY_SECRET', other_partners: 0 },
  fingerprint: FP,
  ...over,
})

const field = () => screen.queryByLabelText('Type DELETE to confirm')
const button = () => screen.getByRole('button', { name: 'Delete Tripoint' })

function renderBox(refreshKey = 'k1', onDeleted = vi.fn()) {
  const utils = render(<PartnerDeleteBox partner={PARTNER} refreshKey={refreshKey} onDeleted={onDeleted} />)
  return { ...utils, onDeleted }
}

beforeEach(() => vi.clearAllMocks())

describe('PartnerDeleteBox', () => {
  it('a failed check offers no field, says so, and Try again checks again (L530)', async () => {
    vi.mocked(api.partners.deleteCheck).mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(clean())
    renderBox()
    expect(await screen.findByRole('alert')).toHaveTextContent(DELETE_CHECK_FAILED)
    expect(field()).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete Tripoint' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByLabelText('Type DELETE to confirm')).toBeInTheDocument()
    expect(api.partners.deleteCheck).toHaveBeenCalledTimes(2)
  })

  it('shows that it is checking, before anything else', () => {
    vi.mocked(api.partners.deleteCheck).mockReturnValue(new Promise(() => {}))
    renderBox()
    expect(screen.getByRole('status')).toHaveTextContent(/Checking what deleting Tripoint would remove/)
    expect(field()).toBeNull()
  })

  it('blocked: why it cannot be deleted and that turning off Active stops it, with no field', async () => {
    vi.mocked(api.partners.deleteCheck).mockResolvedValue(clean({
      blockers: [{ kind: 'rows', table: 'buyer_sales', rows: 6323, noun: { one: 'sale', many: 'sales' } }, { kind: 'ledger_unresolved', count: 1 }],
    }))
    renderBox()
    expect(await screen.findByText('Tripoint cannot be deleted: 6,323 sales refer to it and 1 sale is awaiting settlement.')).toBeInTheDocument()
    expect(screen.getByText('To stop offering it leads, turn off Active.')).toBeInTheDocument()
    expect(field()).toBeNull()
  })

  it('names what this partner has, and enables Delete only for DELETE typed exactly', async () => {
    vi.mocked(api.partners.deleteCheck).mockResolvedValue(clean())
    renderBox()
    expect(await screen.findByText('Removes Tripoint, its buyer profile, 4 matrix history entries and 2 sub-account IDs. This cannot be undone.')).toBeInTheDocument()
    expect(screen.getByText('The Worker secret TRIPOINT_PROXY_SECRET stays. No other partner names it.')).toBeInTheDocument()
    expect(button()).toBeDisabled()
    for (const wrong of ['delete', 'DELETE ', 'DELE']) {
      fireEvent.change(field()!, { target: { value: wrong } })
      expect(button(), wrong).toBeDisabled()
    }
    fireEvent.change(field()!, { target: { value: 'DELETE' } })
    expect(button()).toBeEnabled()
  })

  it('sends the fingerprint it showed, once on a double press, and hands the answer to the page', async () => {
    vi.mocked(api.partners.deleteCheck).mockResolvedValue(clean())
    let resolve!: (v: { ok: true }) => void
    vi.mocked(api.partners.delete).mockReturnValue(new Promise((r) => { resolve = r }))
    const { onDeleted } = renderBox()
    fireEvent.change(await screen.findByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(button())
    fireEvent.click(button())
    expect(await screen.findByText(/Deleting Tripoint/)).toBeInTheDocument()
    resolve({ ok: true })
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith({ ok: true }))
    expect(api.partners.delete).toHaveBeenCalledTimes(1)
    expect(api.partners.delete).toHaveBeenCalledWith('p-tp', FP)
  })

  it('Enter in the field deletes only when DELETE is typed', async () => {
    vi.mocked(api.partners.deleteCheck).mockResolvedValue(clean())
    vi.mocked(api.partners.delete).mockResolvedValue({ ok: true })
    renderBox()
    const input = await screen.findByLabelText('Type DELETE to confirm')
    fireEvent.change(input, { target: { value: 'DELET' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(api.partners.delete).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'DELETE' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.partners.delete).toHaveBeenCalledTimes(1))
  })

  it('a consequence that moved re-renders the box with the new one, and asks for DELETE again', async () => {
    vi.mocked(api.partners.deleteCheck).mockResolvedValue(clean())
    const moved = clean({ removes: [{ table: 'partner_uuid_map', kind: 'deleted', rows: 3, noun: { one: 'sub-account ID', many: 'sub-account IDs' } }] })
    vi.mocked(api.partners.delete).mockRejectedValue(Object.assign(new Error('changed'), { status: 409, body: { error: 'consequence_changed', message: 'What this delete would remove changed since it was shown. Nothing was deleted. Review it again below.', check: moved } }))
    renderBox()
    fireEvent.change(await screen.findByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(button())
    expect(await screen.findByText('Removes Tripoint and 3 sub-account IDs. This cannot be undone.')).toBeInTheDocument()
    expect(screen.getByText(/changed since it was shown/)).toBeInTheDocument()
    expect(field()).toHaveValue('')
    expect(button()).toBeDisabled()
  })

  it('a sale landing after the check shows the partner blocked, and a refusal with no check is a failed check', async () => {
    vi.mocked(api.partners.deleteCheck).mockResolvedValue(clean())
    vi.mocked(api.partners.delete).mockRejectedValueOnce(Object.assign(new Error('blocked'), {
      status: 409, body: { error: 'blocked', message: 'x', check: clean({ blockers: [{ kind: 'rows', table: 'buyer_sales', rows: 1, noun: { one: 'sale', many: 'sales' } }] }) },
    }))
    const { unmount } = renderBox()
    fireEvent.change(await screen.findByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(button())
    expect(await screen.findByText('Tripoint cannot be deleted: 1 sale refers to it.')).toBeInTheDocument()
    expect(screen.getByText('Nothing was deleted.')).toBeInTheDocument()
    expect(field()).toBeNull()
    unmount()

    vi.mocked(api.partners.delete).mockRejectedValueOnce(Object.assign(new Error('blocked'), { status: 409, body: { error: 'blocked', message: 'x', check: null } }))
    renderBox()
    fireEvent.change(await screen.findByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(button())
    expect(await screen.findByText(DELETE_CHECK_FAILED)).toBeInTheDocument()
  })

  it('a delete that fails otherwise says so and keeps the field', async () => {
    vi.mocked(api.partners.deleteCheck).mockResolvedValue(clean())
    vi.mocked(api.partners.delete).mockRejectedValue(Object.assign(new Error('The server could not be reached.'), { status: 500 }))
    renderBox()
    fireEvent.change(await screen.findByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(button())
    expect(await screen.findByRole('alert')).toHaveTextContent('The server could not be reached.')
    expect(field()).toHaveValue('DELETE')
  })

  it('a change seen while a delete is in flight does not race it, and is checked after a failed delete', async () => {
    vi.mocked(api.partners.deleteCheck).mockResolvedValue(clean())
    let reject!: (e: unknown) => void
    vi.mocked(api.partners.delete).mockReturnValue(new Promise((_r, j) => { reject = j }))
    const onDeleted = vi.fn()
    const { rerender } = render(<PartnerDeleteBox partner={PARTNER} refreshKey="k1" onDeleted={onDeleted} />)
    fireEvent.change(await screen.findByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(button())
    rerender(<PartnerDeleteBox partner={PARTNER} refreshKey="k2" onDeleted={onDeleted} />)
    expect(api.partners.deleteCheck).toHaveBeenCalledTimes(1)
    reject(Object.assign(new Error('The server could not be reached.'), { status: 500 }))
    await waitFor(() => expect(api.partners.deleteCheck).toHaveBeenCalledTimes(2))
  })

  it('a page that throws on the answer of a committed delete is logged, never shown as a failed delete', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(api.partners.deleteCheck).mockResolvedValue(clean())
    vi.mocked(api.partners.delete).mockResolvedValue({ ok: true })
    const onDeleted = vi.fn(() => { throw new Error('page broke') })
    renderBox('k1', onDeleted)
    fireEvent.change(await screen.findByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(button())
    await waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('Tripoint was deleted, but the page could not take the answer: page broke')))
    expect(screen.queryByRole('alert')).toBeNull()
    log.mockRestore()
  })

  it('a delete with no clear answer says it may still have gone through', async () => {
    vi.mocked(api.partners.deleteCheck).mockResolvedValue(clean())
    vi.mocked(api.partners.delete).mockRejectedValueOnce(Object.assign(new Error('The server could not be reached.'), { status: 503 }))
    renderBox()
    fireEvent.change(await screen.findByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(button())
    expect(await screen.findByRole('alert')).toHaveTextContent('The server could not be reached. The delete may still have gone through: reload the page to see whether Tripoint is still listed.')
  })

  it('checks again when what it would remove may have changed', async () => {
    vi.mocked(api.partners.deleteCheck).mockResolvedValue(clean())
    const { rerender } = renderBox('k1')
    await screen.findByLabelText('Type DELETE to confirm')
    rerender(<PartnerDeleteBox partner={PARTNER} refreshKey="k2" onDeleted={vi.fn()} />)
    await waitFor(() => expect(api.partners.deleteCheck).toHaveBeenCalledTimes(2))
  })
})

describe('the delete box words', () => {
  it('names each kind of workflow use once, and the switched off ones as such', () => {
    const check = clean({
      workflows_naming_partner: [{ id: 'a', name: 'Main Flow', is_active: true }, { id: 'b', name: 'Old Flow', is_active: false }],
      workflows_reading_values: [
        { id: 'c', name: 'Offer Page', is_active: true, reads: 'by_name', values: ['TripointSellOffOfferTitle'] },
        { id: 'd', name: 'Engine Bidding', is_active: true, reads: 'every_partner', values: ['activeBidding'] },
      ],
    })
    expect(workflowSentences(check)).toEqual([
      'Main Flow and Old Flow (switched off) name Tripoint in a node and will not find it after the delete.',
      'Offer Page reads TripointSellOffOfferTitle and will read nothing for Tripoint after the delete.',
      'Engine Bidding reads activeBidding for every partner; after the delete it holds nothing for Tripoint.',
    ])
  })

  it('says nothing about workflows when none use the partner, and only the partner when it has nothing else', () => {
    expect(workflowSentences(clean())).toEqual([])
    expect(consequenceSentence('Sofi', [])).toBe('Removes Sofi. This cannot be undone.')
    expect(secretSentence(null)).toBeNull()
    expect(secretSentence({ name: 'S', other_partners: 2 })).toBe('The Worker secret S stays. 2 other partners name it.')
  })
})
