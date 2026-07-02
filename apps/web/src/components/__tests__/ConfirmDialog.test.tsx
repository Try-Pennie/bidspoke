/**
 * Issue #492 (AUD-062): the code-worker migration fired real redeploys on a
 * single click with no confirmation. A reusable ConfirmDialog gates such
 * one-click destructive/expensive actions behind an explicit confirm.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ConfirmDialog from '../ConfirmDialog'

describe('ConfirmDialog (#492)', () => {
  it('renders the title, body and both actions', () => {
    render(
      <ConfirmDialog
        title="Run migration?"
        body="This redeploys every workflow."
        confirmLabel="Run migration"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Run migration?')).toBeInTheDocument()
    expect(screen.getByText('This redeploys every workflow.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run migration' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('calls onConfirm when the confirm button is clicked', () => {
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog title="T" body="B" confirmLabel="Go" onConfirm={onConfirm} onCancel={() => {}} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('calls onCancel when the cancel button is clicked', () => {
    const onCancel = vi.fn()
    render(
      <ConfirmDialog title="T" body="B" confirmLabel="Go" onConfirm={() => {}} onCancel={onCancel} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('defaults the confirm label to "Confirm"', () => {
    render(<ConfirmDialog title="T" body="B" onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
  })
})
