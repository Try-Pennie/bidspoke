import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RenameConfirmDialog from '../RenameConfirmDialog'

// This test exercises real DOM rendering and event wiring (not the component
// called as a plain function), proving the jsdom + React Testing Library
// harness works. See issue #157.
describe('RenameConfirmDialog', () => {
  const baseProps = {
    oldNs: 'old_data',
    newNs: 'new_data',
    canvasReferenceCount: 0,
    partnerFormulas: [],
    onConfirm: () => {},
    onCancel: () => {},
  }

  it('renders the old and new namespace names', () => {
    render(<RenameConfirmDialog {...baseProps} />)
    expect(screen.getByText('old_data')).toBeInTheDocument()
    expect(screen.getByText('new_data')).toBeInTheDocument()
  })

  it('calls onConfirm when the Rename button is clicked', async () => {
    const onConfirm = vi.fn()
    render(<RenameConfirmDialog {...baseProps} onConfirm={onConfirm} />)

    await userEvent.click(screen.getByRole('button', { name: 'Rename' }))

    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('calls onCancel when the Cancel button is clicked', async () => {
    const onCancel = vi.fn()
    render(<RenameConfirmDialog {...baseProps} onCancel={onCancel} />)

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('shows the empty-state message when there are no downstream references', () => {
    render(<RenameConfirmDialog {...baseProps} />)
    expect(screen.getByText('No downstream references found.')).toBeInTheDocument()
  })
})
