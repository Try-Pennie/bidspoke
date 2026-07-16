import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

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

const source = (name: string) => ({ name, api_key: 'abc12345def67890', created_at: '2026-01-01T00:00:00Z' })

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
 * a11y spec cannot cover this yet, since the sources page still fails on
 * nested-interactive (#515), so the contract is pinned here instead.
 */
describe('Sources page: the curl source picker is named (#672)', () => {
  it('exposes the source picker with an accessible name', async () => {
    render(<SourcesPage />)

    expect(await screen.findByRole('combobox', { name: /source/i })).toBeInTheDocument()
  })
})
