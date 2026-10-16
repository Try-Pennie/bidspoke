/**
 * The canvas's two dialogs, on the one Dialog shell (#2134). WorkflowCanvas
 * cannot be mounted in jsdom (#737), so each dialog is its own component and is
 * tested here; the canvas only decides when to show it.
 *
 * - Deleting a container that holds nodes (#288): Cancel, Leave them, or
 *   Delete inside too, and every incidental dismissal is Cancel.
 * - Leaving a canvas with unsaved edits (#478): it was the browser's
 *   window.confirm, which a guard now forbids. Keep editing is the safe action;
 *   only Discard and leave leaves.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ContainerDeleteDialog, LeaveCanvasDialog } from '../CanvasDialogs'

describe('ContainerDeleteDialog', () => {
  const props = () => ({ containerLabel: 'Branch', innerCount: 3, onCancel: vi.fn(), onLeaveThem: vi.fn(), onDeleteInside: vi.fn() })

  it('names the container and how many nodes sit inside it', () => {
    render(<ContainerDeleteDialog {...props()} />)
    const dialog = screen.getByRole('alertdialog', { name: 'Delete Branch?' })
    expect(dialog).toHaveAccessibleDescription(/3 nodes sit inside this container/)
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Cancel', 'Leave them', 'Delete inside too'])
  })

  it('says one node for one', () => {
    render(<ContainerDeleteDialog {...props()} innerCount={1} />)
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(/1 node sits inside this container/)
  })

  it('each answer calls only its own action', () => {
    const p = props()
    render(<ContainerDeleteDialog {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Leave them' }))
    expect(p.onLeaveThem).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Delete inside too' }))
    expect(p.onDeleteInside).toHaveBeenCalledTimes(1)
    expect(p.onCancel).not.toHaveBeenCalled()
  })

  it('Escape cancels and deletes nothing', () => {
    const p = props()
    render(<ContainerDeleteDialog {...p} />)
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(p.onCancel).toHaveBeenCalledTimes(1)
    expect(p.onLeaveThem).not.toHaveBeenCalled()
    expect(p.onDeleteInside).not.toHaveBeenCalled()
  })
})

describe('LeaveCanvasDialog', () => {
  it('names the workflow, offers Keep editing first, and leaves only on Discard and leave', () => {
    const onKeepEditing = vi.fn()
    const onDiscard = vi.fn()
    render(<LeaveCanvasDialog workflowName="Engine Bidding" onKeepEditing={onKeepEditing} onDiscard={onDiscard} />)
    const dialog = screen.getByRole('alertdialog', { name: 'Leave Engine Bidding with unsaved changes?' })
    expect(dialog).toHaveAccessibleDescription('Your changes to this workflow are not saved. Leaving discards them.')
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }))
    expect(onDiscard).toHaveBeenCalledTimes(1)
    expect(onKeepEditing).not.toHaveBeenCalled()
  })

  it('Escape keeps editing and discards nothing', () => {
    const onKeepEditing = vi.fn()
    const onDiscard = vi.fn()
    render(<LeaveCanvasDialog workflowName="Engine Bidding" onKeepEditing={onKeepEditing} onDiscard={onDiscard} />)
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(onKeepEditing).toHaveBeenCalledTimes(1)
    expect(onDiscard).not.toHaveBeenCalled()
  })

  it('a workflow with no name yet is called this workflow', () => {
    render(<LeaveCanvasDialog workflowName="  " onKeepEditing={vi.fn()} onDiscard={vi.fn()} />)
    expect(screen.getByRole('alertdialog', { name: 'Leave this workflow with unsaved changes?' })).toBeInTheDocument()
  })
})
