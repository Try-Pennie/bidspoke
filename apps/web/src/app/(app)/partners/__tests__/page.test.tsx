import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// NavLayout pulls in nav/auth chrome irrelevant to the flows under test.
vi.mock('@/components/NavLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}))

// Stub PartnerForm to a lightweight surface. The delete itself, its check, its
// in flight state and its double press guard (#495) live in PartnerDeleteBox
// since #2140 and are tested there; the page owns what happens after a delete
// committed, which the stub drives through onDeleted.
vi.mock('../PartnerForm', () => ({
  __esModule: true,
  default: (props: {
    partner?: { id: string }
    onDeleted?: (id: string, answer: { ok: true; stored_copy_warning?: string; state_reset_warning?: string }) => void
    onSave?: (body: unknown, id?: string, pending?: string[], request?: { expected_partner_version: number; expected_profile_version: number | null; profile: unknown; save_id: string }) => Promise<{ copyWarning: string | null } | void>
  }) => (
    <div>
      <button onClick={() => {
        void props.onSave?.({ is_active: false }, props.partner?.id, undefined, { expected_partner_version: 3, expected_profile_version: null, profile: null, save_id: 'save-1' })
          .then((r) => { const el = document.getElementById('form-copy-warning'); if (el && r) el.textContent = r.copyWarning ?? '' })
      }}>Save</button>
      <span id="form-copy-warning" data-testid="form-copy-warning" />
      <button onClick={() => props.partner && props.onDeleted?.(props.partner.id, (window as unknown as { __deleteAnswer: { ok: true } }).__deleteAnswer)}>Deleted</button>
    </div>
  ),
}))

vi.mock('@/lib/api', () => ({
  api: {
    partners: { usage: () => Promise.resolve({ bid_group: [], partner_bid: [], latency_gate: [] }), workflowValues: () => Promise.resolve({ partner: { id: 'p', slug: 'p' }, values: [], searched: { workflows: 0, with_constants_node: 0 } }),
      list: vi.fn(),
      delete: vi.fn(),
      savePage: vi.fn(),
    },
  },
}))

import PartnersPage from '../page'
import { api } from '@/lib/api'
import { BIDDING_PICKUP } from '@/lib/bidding-pickup'

const partnerA = { id: 'p1', name: 'SoFi', slug: 'sofi', is_active: true }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.partners.list).mockResolvedValue([partnerA] as never)
})

/** Opens SoFi and has its delete box report a committed delete with this answer. */
async function deleteWith(answer: { ok: true; stored_copy_warning?: string; state_reset_warning?: string }) {
  ;(window as unknown as { __deleteAnswer: unknown }).__deleteAnswer = answer
  render(<PartnersPage />)
  fireEvent.click(await screen.findByRole('button', { name: /SoFi/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Deleted' }))
}

describe('Partners page: after a delete committed (#2140)', () => {
  it('says it was deleted, closes the partner and takes its row out of the list', async () => {
    await deleteWith({ ok: true })
    expect(await screen.findByRole('status')).toHaveTextContent('SoFi was deleted.')
    await waitFor(() => expect(screen.queryByRole('button', { name: /SoFi/ })).toBeNull())
    expect(screen.queryByRole('button', { name: 'Deleted' })).toBeNull()
  })

  it('a reset that failed is said beside the delete, never as the page error', async () => {
    const RESET = "SoFi was deleted, but today's lead count kept under the slug sofi could not be reset. A partner created again with the slug sofi today would start with it."
    await deleteWith({ ok: true, state_reset_warning: RESET })
    expect(await screen.findByRole('status')).toHaveTextContent(RESET)
  })
})

// #1846: an edit or delete commits, then clears the stored copy the Partner Bid
// node bids from in a database outage. When KV refuses that, the server answers
// the change as done with stored_copy_warning, and the page shows it.
describe('Partners page: a change whose stored copy was not cleared says so', () => {
  const WARNING = 'The change was saved and recorded, but a stored copy of the old version could not be refreshed.'

  // #2132: an edit's warning goes back to the form, which shows it beside Saved;
  // the page no longer puts a saved edit in its red error banner.
  it('after an edit, handed to the form with the one page save, and never as the page error', async () => {
    vi.mocked(api.partners.savePage).mockResolvedValue({ partner: { ...partnerA, is_active: false }, profile: null, partner_version: 4, profile_version: 0, stored_copy_warning: WARNING } as never)
    render(<PartnersPage />)
    fireEvent.click(await screen.findByRole('button', { name: /SoFi/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByTestId('form-copy-warning')).toHaveTextContent(WARNING))
    expect(api.partners.savePage).toHaveBeenCalledWith('p1', { is_active: false }, { expected_partner_version: 3, expected_profile_version: null, profile: null, save_id: 'save-1' })
    expect(screen.getAllByText(WARNING)).toHaveLength(1)
  })

  // #2132: a press whose answer was lost but whose save landed comes back as a
  // 409 carrying its own save id. The page takes the stored row as the saved one,
  // so its list and selection show it, and hands the form a success.
  it('a 409 carrying this press\'s own save id updates the list with the stored row', async () => {
    vi.mocked(api.partners.savePage).mockRejectedValue(Object.assign(new Error('stale_version'), {
      status: 409,
      body: { error: 'stale_version', partner: { ...partnerA, name: 'SoFi Renamed', is_active: false }, profile: null, partner_version: 4, profile_version: 0, last_save_id: 'save-1', changed_by_name: 'Dan', changed_at: '2026-10-15T18:02:00Z' },
    }))
    render(<PartnersPage />)
    fireEvent.click(await screen.findByRole('button', { name: /SoFi/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('button', { name: /SoFi Renamed/ })).toBeInTheDocument()
  })

  // #2140: as a standing notice with when bidding stops using it, never the red error.
  it('after a delete', async () => {
    await deleteWith({ ok: true, stored_copy_warning: WARNING })
    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent(WARNING)
    expect(notice).toHaveTextContent(`Bidding stops using SoFi within about ${BIDDING_PICKUP.partnerConstantsMinutes} minutes while the database is reachable.`)
  })
})

describe('the page states (#2321, PM-18)', () => {
  it('nothing selected: the bold prompt and how to create one, with no icons', async () => {
    const { container } = render(<PartnersPage />)
    const prompt = await screen.findByText('Select a partner to configure')
    expect(prompt).toHaveClass('font-semibold')
    expect(screen.getByText('Or create a new one with the button above.')).toBeInTheDocument()
    expect(container.querySelector('[data-form-pane] svg')).toBeNull()
  })

  it('loading: placeholder rows in the list and nothing on the right', () => {
    vi.mocked(api.partners.list).mockReturnValue(new Promise(() => {}) as never)
    const { container } = render(<PartnersPage />)
    expect(screen.getByRole('status', { name: 'Loading partners' })).toBeInTheDocument()
    expect(container.querySelectorAll('.partner-skeleton-row')).toHaveLength(5)
    expect(container.querySelector('[data-form-pane]')).toBeEmptyDOMElement()
  })

  it('could not be loaded: says so on the right with why and Try again, never as an empty list', async () => {
    vi.mocked(api.partners.list).mockRejectedValueOnce(Object.assign(new Error('Internal error'), { status: 500 }))
    render(<PartnersPage />)
    expect(await screen.findByText('Partners could not be loaded')).toBeInTheDocument()
    expect(screen.getByText('The server answered with an error (HTTP 500). Nothing has changed.')).toBeInTheDocument()
    expect(screen.queryByText('No partners yet')).toBeNull()
    expect(screen.queryByText(/Internal error/)).toBeNull()
    vi.mocked(api.partners.list).mockResolvedValueOnce([partnerA] as never)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'SoFi' })).toBeInTheDocument()
    expect(screen.queryByText('Partners could not be loaded')).toBeNull()
  })
})
