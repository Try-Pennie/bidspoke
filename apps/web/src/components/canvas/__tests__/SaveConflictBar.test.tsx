/**
 * The canvas's save conflict strip and its two dialogs (#2599, settled design
 * docs/design/canvas-save-conflict.html, R1 to R4). WorkflowCanvas cannot be
 * mounted in jsdom (#737), so the strip is its own component, tested here; the
 * canvas decides when it shows and what each confirmed answer does.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { SaveConflictBar } from '../SaveConflictBar'
import type { StaleSave } from '@/lib/workflow-save-conflict'

const MARIA: StaleSave = { version: 7, changedByName: 'Maria Lopez', changedAt: '2026-10-23T02:41:00Z' }
const NOBODY: StaleSave = { version: 7, changedByName: null, changedAt: '2026-10-23T02:41:00Z' }

const props = (stale = MARIA) => ({ stale, onLoadTheirs: vi.fn(async () => {}), onSaveOver: vi.fn(async () => {}) })

const strip = () => document.querySelector<HTMLElement>('[data-part="save-conflict"]')!

describe('SaveConflictBar', () => {
  it('R1 and R2: says who saved and when, then offers Load their version and Save mine over theirs', () => {
    render(<SaveConflictBar {...props()} />)
    expect(strip()).toHaveTextContent('Not saved. Maria Lopez saved this workflow at Oct 22, 10:41 PM ET, after you opened it. Your changes are still on the canvas.')
    expect(within(strip()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Load their version', 'Save mine over theirs'])
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('R1: says the change came from outside the canvas when nobody is named', () => {
    render(<SaveConflictBar {...props(NOBODY)} />)
    expect(strip()).toHaveTextContent('Not saved. This workflow was changed at Oct 22, 10:41 PM ET, outside the canvas, after you opened it.')
  })

  it('R3: Save mine over theirs asks first, and only Save over theirs saves', async () => {
    const p = props()
    render(<SaveConflictBar {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save mine over theirs' }))
    const dialog = screen.getByRole('alertdialog', { name: "Save over Maria Lopez's version?" })
    expect(dialog).toHaveAccessibleDescription('Their save at Oct 22, 10:41 PM ET is replaced by your changes. It stays in Version history.')
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Cancel', 'Save over theirs'])
    expect(p.onSaveOver).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save over theirs' })) })
    expect(p.onSaveOver).toHaveBeenCalledTimes(1)
    expect(p.onLoadTheirs).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('R4: Load their version asks first, and only Load theirs loads', async () => {
    const p = props()
    render(<SaveConflictBar {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Load their version' }))
    const dialog = screen.getByRole('alertdialog', { name: "Load Maria Lopez's version?" })
    expect(dialog).toHaveAccessibleDescription('Your unsaved changes on the canvas are discarded and cannot be brought back.')
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Cancel', 'Load theirs'])
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Load theirs' })) })
    expect(p.onLoadTheirs).toHaveBeenCalledTimes(1)
    expect(p.onSaveOver).not.toHaveBeenCalled()
  })

  it('Cancel and Escape close a dialog and do nothing', () => {
    const p = props()
    render(<SaveConflictBar {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save mine over theirs' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Load their version' }))
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(p.onSaveOver).not.toHaveBeenCalled()
    expect(p.onLoadTheirs).not.toHaveBeenCalled()
  })

  // The answer takes a round trip, so the dialog stays open, its action busy,
  // until it has, and cannot be dismissed meanwhile.
  it('holds the dialog open and its action busy until the answer finishes', async () => {
    let finish: () => void = () => {}
    const p = { ...props(), onLoadTheirs: vi.fn(() => new Promise<void>((r) => { finish = r })) }
    render(<SaveConflictBar {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Load their version' }))
    fireEvent.click(screen.getByRole('button', { name: 'Load theirs' }))
    expect(screen.getByRole('button', { name: 'Load theirs' })).toHaveAttribute('aria-busy', 'true')
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await act(async () => { finish() })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
