import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// NavLayout pulls in nav/auth chrome irrelevant to the control under test.
vi.mock('@/components/NavLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/lib/api', () => ({
  api: {
    sources: {
      list: vi.fn(),
      listAssignments: vi.fn(),
      assignWorkflow: vi.fn(),
      unassignWorkflow: vi.fn(),
      delete: vi.fn(),
    },
    workflows: { list: vi.fn() },
  },
}))

import SourcesPage from '../page'
import { api } from '@/lib/api'

// Deliberately low-entropy and hyphenated: the page slices the first 8 chars for
// the curl example, and a random-looking literal trips the gitleaks secret scan.
const source = (name: string) => ({ name, api_key: 'not-a-real-key', created_at: '2026-01-01T00:00:00Z' })

beforeEach(() => {
  vi.clearAllMocks()
  // The picker only renders with more than one source (page.tsx:385).
  vi.mocked(api.sources.list).mockResolvedValue([source('alpha'), source('beta')] as never)
  vi.mocked(api.workflows.list).mockResolvedValue([] as never)
  vi.mocked(api.sources.listAssignments).mockResolvedValue([] as never)
})

/**
 * axe rates an unnamed select `critical` (select-name): a screen reader
 * announces it as just "combobox", with no clue what it changes. The page-level
 * a11y spec now scans this page (the nested-interactive blocker, #515, is
 * fixed), but the name is pinned here too: the e2e org's source list is data
 * that could empty out, and this renders the picker unconditionally.
 */
describe('Sources page: the curl source picker is named (#672)', () => {
  it('exposes the source picker with an accessible name', async () => {
    render(<SourcesPage />)

    expect(await screen.findByRole('combobox', { name: /source/i })).toBeInTheDocument()
  })
})

/**
 * The card used to be a role=button/tabIndex=0 wrapper around Revoke, Reveal,
 * Copy and a select (#515). Two things broke: axe flags nested-interactive, and
 * the card's own Enter/Space handler called preventDefault() on a keydown that
 * BUBBLES up from the inner buttons, cancelling their activation. The inner
 * buttons only stopped propagation on `click`, which is too late.
 */
describe('Sources page: card controls are keyboard-operable (#515)', () => {
  async function alphaCard() {
    // The source name is the card's own selection control; the card wrapping it
    // must stay a plain container.
    const nameButton = await screen.findByRole('button', { name: /alpha/i })
    return nameButton.closest('[data-testid="source-card"]') as HTMLElement
  }

  it('activates Revoke with the keyboard rather than selecting the card', async () => {
    const user = userEvent.setup()
    render(<SourcesPage />)
    const card = await alphaCard()

    await user.tab()
    await within(card).getByRole('button', { name: 'Revoke' }).focus()
    await user.keyboard('{Enter}')

    // Revoke asks for confirmation before it deletes: the Cancel affordance
    // appearing is proof the button actually fired.
    expect(await within(card).findByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('activates Reveal with the keyboard', async () => {
    const user = userEvent.setup()
    render(<SourcesPage />)
    const card = await alphaCard()

    await within(card).getByRole('button', { name: /reveal api key/i }).focus()
    await user.keyboard('{Enter}')

    expect(await within(card).findByRole('button', { name: /hide api key/i })).toBeInTheDocument()
  })

  it('does not nest interactive controls inside another interactive element', async () => {
    render(<SourcesPage />)
    const card = await alphaCard()

    expect(card).not.toHaveAttribute('role', 'button')
    expect(card).not.toHaveAttribute('tabindex')
  })

  it('still selects the source for the curl example from the card', async () => {
    const user = userEvent.setup()
    render(<SourcesPage />)
    const betaName = await screen.findByRole('button', { name: /beta/i })

    await user.click(betaName)

    expect(betaName).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByRole('button', { name: /alpha/i })).toHaveAttribute('aria-pressed', 'false')
  })
})
