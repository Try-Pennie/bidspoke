/**
 * #1035: the missing-credential warning must be visible on the partner LIST,
 * not only inside the partner's own settings form.
 *
 * #416 added the save-time check so a partner whose declared credential is unset
 * is caught before a live lead hits it. But it rendered only inside that
 * partner's form, so it was visible only to someone who had already opened that
 * partner. The list is where a person scanning their partners would notice, and
 * a warning nobody passes by does not catch much.
 *
 * The marker is not itself interactive: the whole row is one button, so a nested
 * control would both be invalid markup and compete with opening the partner. It
 * carries its message as text for a screen reader and as a title for a pointer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/components/NavLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}))
vi.mock('../PartnerForm', () => ({
  __esModule: true,
  UNSAVED_CHANGES_MESSAGE: 'unsaved',
  default: () => <div />,
}))
vi.mock('@/lib/api', () => ({
  api: { partners: { list: vi.fn(), delete: vi.fn() } },
}))

import PartnersPage from '../page'
import { api } from '@/lib/api'

const WARNING = "Credential 'SOFI_SECRET' is not set, so this partner will fail on the next live lead."

const healthy = { id: 'p1', name: 'SoFi', slug: 'sofi', is_active: true, credential_warning: null }
const broken = { id: 'p2', name: 'Tripoint', slug: 'tripoint', is_active: true, credential_warning: WARNING }

beforeEach(() => vi.clearAllMocks())

describe('Partners list: missing-credential marker (#1035)', () => {
  it('shows the warning message on the affected row', async () => {
    vi.mocked(api.partners.list).mockResolvedValue([healthy, broken] as never)
    render(<PartnersPage />)
    // The full message is what reaches a screen reader, not a bare icon.
    expect(await screen.findByText(WARNING)).toBeInTheDocument()
  })

  it('does not mark a partner whose credential is fine', async () => {
    // The positive case above and this one share one fixture, so the absence
    // here is a real discrimination rather than a page that renders nothing.
    vi.mocked(api.partners.list).mockResolvedValue([healthy, broken] as never)
    render(<PartnersPage />)
    await screen.findByText(WARNING)
    const rows = screen.getAllByRole('button', { name: /SoFi|Tripoint/ })
    const sofiRow = rows.find((r) => r.textContent?.includes('SoFi'))!
    expect(sofiRow.textContent).not.toContain('Credential')
  })

  it('renders no marker at all when every partner is healthy', async () => {
    vi.mocked(api.partners.list).mockResolvedValue([healthy] as never)
    render(<PartnersPage />)
    await screen.findByRole('button', { name: /SoFi/ })
    expect(screen.queryByText(/Credential/)).not.toBeInTheDocument()
  })

  it('keeps the marker out of the row as a separate control (the row stays one button)', async () => {
    vi.mocked(api.partners.list).mockResolvedValue([broken] as never)
    render(<PartnersPage />)
    const row = await screen.findByRole('button', { name: /Tripoint/ })
    // A nested button would be invalid markup inside a button and would steal
    // the click that opens the partner.
    expect(row.querySelectorAll('button, a, input')).toHaveLength(0)
  })

  it('a partner list row still opens the partner when it carries a warning', async () => {
    vi.mocked(api.partners.list).mockResolvedValue([broken] as never)
    render(<PartnersPage />)
    const row = await screen.findByRole('button', { name: /Tripoint/ })
    expect(row).toBeEnabled()
  })
})
