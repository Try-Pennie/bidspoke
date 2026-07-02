/**
 * Issue #492 (AUD-062): the migration ran on a single click with no confirm,
 * and re-clicks/reloads could double-fire real worker redeploys. It now gates
 * behind a ConfirmDialog and shows elapsed time while running.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('@/components/NavLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const migrateCodeWorkers = vi.fn()
vi.mock('@/lib/api', () => ({
  api: { admin: { migrateCodeWorkers: () => migrateCodeWorkers() } },
}))

import MigrateCodeWorkersPage from '../page'

beforeEach(() => {
  migrateCodeWorkers.mockReset()
})

describe('MigrateCodeWorkersPage confirm gating (#492)', () => {
  it('does not fire the migration until the confirm dialog is accepted', async () => {
    migrateCodeWorkers.mockResolvedValue({ migrated: 0, skipped: 0, errored: 0, results: [] })
    render(<MigrateCodeWorkersPage />)

    fireEvent.click(screen.getByRole('button', { name: /run migration/i }))
    // A confirm dialog appears; nothing fired yet.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(migrateCodeWorkers).not.toHaveBeenCalled()

    // Confirm inside the dialog.
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /run migration/i }))
    await waitFor(() => expect(migrateCodeWorkers).toHaveBeenCalledTimes(1))
  })

  it('does not fire when the confirm is cancelled', () => {
    render(<MigrateCodeWorkersPage />)
    fireEvent.click(screen.getByRole('button', { name: /run migration/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(migrateCodeWorkers).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
