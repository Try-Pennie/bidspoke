/**
 * The partners page list and URL (#2137, PM-1, PM-12): the list grouped into
 * Buyers and Sources, alphabetical, name only, with a red mark on a row whose
 * partner has a problem; the partner and its tab in the URL through one
 * builder, mirrored with replaceState.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within, act } from '@testing-library/react'

vi.mock('@/components/NavLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

let params = new URLSearchParams()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => ({ get: (k: string) => params.get(k) }),
}))

const formProps = vi.fn()
vi.mock('../PartnerForm', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    formProps(props)
    return <div data-testid="form">{String((props.partner as { slug?: string } | undefined)?.slug ?? 'new')}</div>
  },
}))

vi.mock('@/lib/api', () => ({
  api: { partners: { list: vi.fn(), delete: vi.fn(), savePage: vi.fn(), create: vi.fn() } },
}))

import PartnersPage from '../page'
import { api } from '@/lib/api'

const row = (id: string, name: string, partner_type: string, over: { credential_warning?: string; is_active?: boolean } = {}): { id: string; name: string; slug: string; partner_type: string; is_active: boolean; credential_warning?: string } => ({ id, name, slug: name.toLowerCase(), partner_type, is_active: true, ...over })
// The nine partners as production holds them (fixture partners.json), shuffled.
const nine = [
  row('t', 'Tripoint', 'buyer'), row('s', 'Sofi', 'source'), row('a', 'AmOne', 'buyer', { credential_warning: "Credential 'AMONE_PROXY_SECRET' is not set, so this partner will fail on the next live lead." }),
  row('n', 'NerdWallet', 'source'), row('g', 'GigFi', 'buyer'), row('d', 'Dot818', 'source'), row('l', 'Liberty1', 'buyer', { is_active: false }),
  row('b', 'Brainsome', 'source'), row('w', 'LendSwift', 'buyer'),
]

let replaceState: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.clearAllMocks()
  params = new URLSearchParams()
  window.history.replaceState(null, '', '/partners')
  replaceState = vi.spyOn(window.history, 'replaceState')
  vi.mocked(api.partners.list).mockResolvedValue(nine as never)
})
afterEach(() => replaceState.mockRestore())

const lastUrl = () => String(replaceState.mock.calls.at(-1)?.[2] ?? '')

describe('the partner list (#2137)', () => {
  it('groups Buyers then Sources, each alphabetical, name only', async () => {
    render(<PartnersPage />)
    const buyers = await screen.findByRole('region', { name: 'Buyers' })
    const sources = screen.getByRole('region', { name: 'Sources' })
    expect(within(buyers).getAllByRole('button').map((b) => b.textContent)).toEqual(['AmOne' + nine[2].credential_warning, 'GigFi', 'LendSwift', 'Liberty1', 'Tripoint'])
    expect(within(sources).getAllByRole('button').map((b) => b.textContent)).toEqual(['Brainsome', 'Dot818', 'NerdWallet', 'Sofi'])
    // Name only: no slug and no inactive chip on a row.
    expect(screen.queryByText('tripoint')).toBeNull()
    expect(screen.queryByText('inactive')).toBeNull()
  })

  it('lists a partner that does both under both headings', async () => {
    vi.mocked(api.partners.list).mockResolvedValue([row('e', 'Engine', 'both'), row('t', 'Tripoint', 'buyer')] as never)
    render(<PartnersPage />)
    expect(within(await screen.findByRole('region', { name: 'Buyers' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['Engine', 'Tripoint'])
    expect(within(screen.getByRole('region', { name: 'Sources' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['Engine'])
  })

  it('marks the row of a partner with a missing credential with the one red mark, its reason read to a screen reader', async () => {
    const { container } = render(<PartnersPage />)
    const amone = await screen.findByRole('button', { name: /AmOne/ })
    expect(amone).toHaveAccessibleName(`AmOne${nine[2].credential_warning}`)
    expect(container.querySelectorAll('[data-problem-mark]')).toHaveLength(1)
    expect(within(amone).getByTitle(nine[2].credential_warning as string)).toBeInTheDocument()
  })

  it('marks the open partner\'s row when its form reports a problem', async () => {
    const { container } = render(<PartnersPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Tripoint' }))
    const props = formProps.mock.calls.at(-1)![0] as { onProblemChange: (b: boolean) => void }
    act(() => props.onProblemChange(true))
    expect(container.querySelectorAll('[data-problem-mark]')).toHaveLength(2)
    // True whether the problem marks a tab or sits at page level (an off page field like List order).
    expect(screen.getByRole('button', { name: /^Tripoint/ })).toHaveAccessibleName('TripointThis partner has a problem: see the form.')
  })
})

describe('the URL (#2137)', () => {
  // Dan, 2026-10-17: opened on ?selected=liberty1 (a hard refresh), clicking another
  // partner snapped straight back to Liberty1. The URL is written with replaceState,
  // and the selected= read back from it stayed the one the page opened on, so the
  // effect that opens the partner the URL names put Liberty1 back after every click.
  it('another partner clicked on a page opened with a tab opens on its own tab, not the one the URL named', async () => {
    params = new URLSearchParams('selected=liberty1&tab=bid-group')
    render(<PartnersPage />)
    expect(await screen.findByTestId('form')).toHaveTextContent('liberty1')
    expect((formProps.mock.calls.at(-1)![0] as { requestedTab: unknown }).requestedTab).toBe('bid_group')
    fireEvent.click(screen.getByRole('button', { name: /^AmOne/ }))
    expect(screen.getByTestId('form')).toHaveTextContent('amone')
    expect((formProps.mock.calls.at(-1)![0] as { requestedTab: unknown }).requestedTab).toBeNull()
  })

  it('clicking back to the opening partner writes it into the URL again', async () => {
    params = new URLSearchParams('selected=liberty1')
    render(<PartnersPage />)
    expect(await screen.findByTestId('form')).toHaveTextContent('liberty1')
    fireEvent.click(screen.getByRole('button', { name: /^AmOne/ }))
    expect(lastUrl()).toBe('/partners?selected=amone')
    fireEvent.click(screen.getByRole('button', { name: 'Liberty1' }))
    expect(screen.getByTestId('form')).toHaveTextContent('liberty1')
    expect(lastUrl()).toBe('/partners?selected=liberty1')
  })

  it('a URL that names a partner again after naming none opens it again (Back, or a link)', async () => {
    params = new URLSearchParams('selected=liberty1')
    const view = render(<PartnersPage />)
    expect(await screen.findByTestId('form')).toHaveTextContent('liberty1')
    params = new URLSearchParams()
    view.rerender(<PartnersPage />)
    fireEvent.click(screen.getByRole('button', { name: /^AmOne/ }))
    expect(screen.getByTestId('form')).toHaveTextContent('amone')
    params = new URLSearchParams('selected=liberty1')
    view.rerender(<PartnersPage />)
    expect(screen.getByTestId('form')).toHaveTextContent('liberty1')
  })

  it('a page opened on one partner opens another when its row is clicked, and stays on it', async () => {
    params = new URLSearchParams('selected=liberty1')
    render(<PartnersPage />)
    expect(await screen.findByTestId('form')).toHaveTextContent('liberty1')
    fireEvent.click(screen.getByRole('button', { name: /^AmOne/ }))
    expect(screen.getByTestId('form')).toHaveTextContent('amone')
    expect(lastUrl()).toBe('/partners?selected=amone')
    fireEvent.click(screen.getByRole('button', { name: 'Tripoint' }))
    expect(screen.getByTestId('form')).toHaveTextContent('tripoint')
  })

  it('choosing a partner writes ?selected through replaceState, and a tab change adds the tab', async () => {
    render(<PartnersPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Tripoint' }))
    expect(lastUrl()).toBe('/partners?selected=tripoint')
    const props = formProps.mock.calls.at(-1)![0] as { onTabChange: (t: string) => void }
    act(() => props.onTabChange('bid_group'))
    expect(lastUrl()).toBe('/partners?selected=tripoint&tab=bid-group')
  })

  it('a tab in the URL is handed to the form; one naming no tab asks for the first', async () => {
    params = new URLSearchParams('selected=tripoint&tab=history')
    render(<PartnersPage />)
    await screen.findByTestId('form')
    expect(formProps.mock.calls.at(-1)![0]).toMatchObject({ requestedTab: 'history' })

    params = new URLSearchParams('selected=tripoint&tab=nonsense')
    formProps.mockClear()
    render(<PartnersPage />)
    await vi.waitFor(() => expect(formProps).toHaveBeenCalled())
    expect(formProps.mock.calls.at(-1)![0]).toMatchObject({ requestedTab: 'partner' })
  })

  it('hands the form every partner\'s name, for the Bids in row', async () => {
    params = new URLSearchParams('selected=amone')
    render(<PartnersPage />)
    await screen.findByTestId('form')
    const names = (formProps.mock.calls.at(-1)![0] as { partnerNames: Map<string, string> }).partnerNames
    expect(names.get('t')).toBe('Tripoint')
    expect(names.size).toBe(9)
  })
})
