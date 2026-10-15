/**
 * The one Dialog shell of the app (#2134, L613), on @radix-ui/react-dialog.
 *
 * Every dialog in apps/web is built on it, so its contract is tested here once:
 * the semantics a screen reader needs (role, aria-modal, a name and a
 * description), focus moved in, held in, and given back, and dismissal (L628):
 * Escape, a click outside and a back gesture all call onDismiss, the dialog's
 * declared safe action, and never the committing or destructive one. These
 * replace the tests of the hand rolled useFocusTrap it supersedes.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode, useState } from 'react'
import { Dialog } from '../Dialog'
import { Button } from '../ui/form'

function Example({ onDismiss = vi.fn(), onConfirm = vi.fn(), warning }: { onDismiss?: () => void; onConfirm?: () => void; warning?: boolean }) {
  return (
    <Dialog
      title="Delete matrix?"
      description="Its 12 rows go with it."
      onDismiss={onDismiss}
      warning={warning}
      actions={<><Button variant="secondary" onClick={onDismiss}>Keep it</Button><Button variant="destructive" onClick={onConfirm}>Delete matrix</Button></>}
    >
      <p>Body text</p>
    </Dialog>
  )
}

describe('Dialog', () => {
  it('is a modal dialog named by its title and described by its sentence', () => {
    render(<Example />)
    const dialog = screen.getByRole('dialog', { name: 'Delete matrix?' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleDescription('Its 12 rows go with it.')
    expect(dialog).toHaveTextContent('Body text')
  })

  it('is an alertdialog when the caller says the question is a warning', () => {
    render(<Example warning />)
    expect(screen.getByRole('alertdialog', { name: 'Delete matrix?' })).toHaveAttribute('aria-modal', 'true')
  })

  it('moves focus to its first control, the safe one', () => {
    render(<Example />)
    expect(screen.getByRole('button', { name: 'Keep it' })).toHaveFocus()
  })

  it('Escape calls onDismiss and never the action', () => {
    const onDismiss = vi.fn()
    const onConfirm = vi.fn()
    render(<Example onDismiss={onDismiss} onConfirm={onConfirm} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('a click outside calls onDismiss and never the action', async () => {
    const onDismiss = vi.fn()
    const onConfirm = vi.fn()
    render(<Example onDismiss={onDismiss} onConfirm={onConfirm} />)
    // The scrim covers the whole page behind the dialog, so it is where a click
    // outside lands. Its listener is attached a task after opening, so the click
    // that opened a dialog cannot also close it: wait on the outcome, not a time.
    const scrim = document.querySelector('.dialog-overlay')
    expect(scrim).not.toBeNull()
    await waitFor(() => {
      fireEvent.pointerDown(scrim!)
      fireEvent.pointerUp(scrim!)
      fireEvent.click(scrim!)
      expect(onDismiss).toHaveBeenCalledTimes(1)
    })
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('a back gesture calls onDismiss', () => {
    const onDismiss = vi.fn()
    render(<Example onDismiss={onDismiss} />)
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('holds Tab inside: from the last control Tab returns to the first', () => {
    render(<Example />)
    const last = screen.getByRole('button', { name: 'Delete matrix' })
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(screen.getByRole('button', { name: 'Keep it' })).toHaveFocus()
  })

  it('a warning must say what answering it does: an alert dialog is announced by its description', () => {
    // @ts-expect-error a warning with no description does not compile
    const noDescription = <Dialog warning title="Delete?" onDismiss={() => {}} actions={null} />
    expect(noDescription).toBeTruthy()
  })

  it('gives focus back to what had it under strict mode, which runs renders twice', async () => {
    function Host() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open</button>
          {open && <Dialog title="T" onDismiss={() => setOpen(false)} actions={<Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>} />}
        </>
      )
    }
    render(<StrictMode><Host /></StrictMode>)
    const opener = screen.getByRole('button', { name: 'Open' })
    opener.focus()
    fireEvent.click(opener)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus())
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('gives focus back to what had it when it closes', async () => {
    function Host() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open</button>
          {open && <Dialog title="T" onDismiss={() => setOpen(false)} actions={<Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>} />}
        </>
      )
    }
    render(<Host />)
    const opener = screen.getByRole('button', { name: 'Open' })
    opener.focus()
    fireEvent.click(opener)
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(opener).toHaveFocus())
  })
})
