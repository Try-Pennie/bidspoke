import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// NavLayout pulls in nav/auth chrome irrelevant to the delete flow under test.
vi.mock('@/components/NavLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}))

// Stub PartnerForm to a lightweight surface: the page owns the delete state
// machine (in-flight tracking, double-fire guard) — that's the unit under test
// (AUD-065 / #495). The stub exposes the `deleting` prop and the confirm button
// so we can drive and observe the page's behaviour without the heavy real form.
vi.mock('../PartnerForm', () => ({
  __esModule: true,
  UNSAVED_CHANGES_MESSAGE: 'unsaved',
  default: (props: {
    partner?: { id: string }
    deleting?: boolean
    confirmingDelete?: boolean
    onDelete?: (id: string) => void
    onConfirmDelete?: () => void
  }) => (
    <div>
      <span data-testid="deleting">{String(props.deleting)}</span>
      {props.confirmingDelete ? (
        <button onClick={props.onConfirmDelete}>Confirm delete</button>
      ) : (
        <button onClick={() => props.partner && props.onDelete?.(props.partner.id)}>Delete</button>
      )}
    </div>
  ),
}))

vi.mock('@/lib/api', () => ({
  api: {
    partners: {
      list: vi.fn(),
      delete: vi.fn(),
    },
  },
}))

import PartnersPage from '../page'
import { api } from '@/lib/api'

const partnerA = { id: 'p1', name: 'SoFi', slug: 'sofi', is_active: true }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.partners.list).mockResolvedValue([partnerA] as never)
})

async function selectAndConfirm() {
  render(<PartnersPage />)
  fireEvent.click(await screen.findByRole('button', { name: /SoFi/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  return screen.getByRole('button', { name: 'Confirm delete' })
}

describe('Partners page — delete in-flight state (#495 / AUD-065)', () => {
  it('passes deleting=true to the form while the delete request is in flight', async () => {
    let resolveDelete!: () => void
    vi.mocked(api.partners.delete).mockReturnValue(
      new Promise<{ ok: boolean }>((res) => { resolveDelete = () => res({ ok: true }) }) as never,
    )

    const confirm = await selectAndConfirm()
    expect(screen.getByTestId('deleting')).toHaveTextContent('false')

    fireEvent.click(confirm)
    await waitFor(() => expect(screen.getByTestId('deleting')).toHaveTextContent('true'))

    resolveDelete()
    await waitFor(() => expect(api.partners.delete).toHaveBeenCalledTimes(1))
  })

  it('fires the delete API exactly once even on a double-click', async () => {
    let resolveDelete!: () => void
    vi.mocked(api.partners.delete).mockReturnValue(
      new Promise<{ ok: boolean }>((res) => { resolveDelete = () => res({ ok: true }) }) as never,
    )

    const confirm = await selectAndConfirm()
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    resolveDelete()
    await waitFor(() => expect(api.partners.delete).toHaveBeenCalledTimes(1))
  })
})
