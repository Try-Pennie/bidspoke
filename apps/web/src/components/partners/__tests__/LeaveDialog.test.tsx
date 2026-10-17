/**
 * The leave dialog's shell (#2322, PM-19, design frame 11): wide enough that
 * Keep editing, Discard and open, and Save and open sit on one line.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LeaveDialog } from '../LeaveDialog'

describe('LeaveDialog', () => {
  it('is the wide dialog, holding its three actions', () => {
    render(<LeaveDialog who="Liberty1" units={[{ key: 'name', tab: 'partner', section: 'Name', label: 'Name' }]} unconfirmed={null} destination={{ kind: 'partner', name: 'AmOne' }} onKeepEditing={vi.fn()} onDiscard={vi.fn()} onSave={vi.fn()} />)
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveClass('dialog-wide')
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Keep editing', 'Discard and open AmOne', 'Save and open AmOne'])
  })
})
