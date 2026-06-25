import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useFocusTrap, getFocusableElements } from '../useFocusTrap'

function Dialog({ onClose }: { onClose: () => void }) {
  const ref = useFocusTrap<HTMLDivElement>(true, onClose)
  return (
    <div>
      <button>outside</button>
      <div ref={ref} role="dialog">
        <button>first</button>
        <button>second</button>
        <button disabled>disabled</button>
        <button>last</button>
      </div>
    </div>
  )
}

describe('getFocusableElements', () => {
  it('returns enabled focusables in order and skips disabled ones', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<a href="#x">a</a><button>b</button><button disabled>c</button>' +
      '<input /><input disabled /><div tabindex="0">d</div><div tabindex="-1">e</div>'
    const els = getFocusableElements(root)
    expect(els.map((e) => e.tagName.toLowerCase())).toEqual(['a', 'button', 'input', 'div'])
  })
})

describe('useFocusTrap', () => {
  it('moves focus to the first focusable on mount', () => {
    render(<Dialog onClose={() => {}} />)
    expect(document.activeElement).toBe(screen.getByText('first'))
  })

  it('calls onEscape when Escape is pressed', () => {
    const onClose = vi.fn()
    render(<Dialog onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('wraps Tab from the last focusable back to the first', () => {
    render(<Dialog onClose={() => {}} />)
    const last = screen.getByText('last')
    last.focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByText('first'))
  })

  it('wraps Shift+Tab from the first focusable to the last', () => {
    render(<Dialog onClose={() => {}} />)
    expect(document.activeElement).toBe(screen.getByText('first'))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByText('last'))
  })

  it('restores focus to the previously focused element on unmount', () => {
    const Wrapper = ({ open }: { open: boolean }) => (
      <div>
        <button>trigger</button>
        {open && <Dialog onClose={() => {}} />}
      </div>
    )
    const { rerender } = render(<Wrapper open={false} />)
    const trigger = screen.getByText('trigger')
    trigger.focus()
    expect(document.activeElement).toBe(trigger)
    rerender(<Wrapper open={true} />)
    expect(document.activeElement).toBe(screen.getByText('first'))
    rerender(<Wrapper open={false} />)
    expect(document.activeElement).toBe(trigger)
  })
})
