/**
 * The design system form primitives (#1412, L607). Every control the buyer
 * profile section renders comes from here, with its own class so the
 * geometry can differ by control (a select is not an input), a real label
 * reachable by keyboard and screen reader, and the three states an action can
 * be in (working, still alive, failed) told apart at a glance.
 */
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { Field, TextInput, NumberInput, Select, Toggle, Checkbox, Button, Outcome, type OutcomeState } from '../form'

describe('Field', () => {
  it('labels the control by id and attaches the hint and the error as descriptions', () => {
    render(
      <Field id="f" label="Debt minimum" hint="Dollars." error="Debt minimum must be a number.">
        <TextInput id="f" value="" onChange={() => {}} describedBy="f-hint f-error" />
      </Field>
    )
    const input = screen.getByLabelText('Debt minimum')
    expect(input).toHaveAttribute('aria-describedby', 'f-hint f-error')
    expect(screen.getByText('Dollars.')).toHaveAttribute('id', 'f-hint')
    expect(screen.getByRole('alert')).toHaveTextContent('Debt minimum must be a number.')
    expect(screen.getByRole('alert')).toHaveAttribute('id', 'f-error')
  })
})

describe('TextInput and Select carry their own classes', () => {
  it('a text input is .input and a select is .select, never the same class', () => {
    render(
      <>
        <TextInput id="t" value="x" onChange={() => {}} aria-label="Text" />
        <Select id="s" value="a" onChange={() => {}} aria-label="Pick" options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />
      </>
    )
    expect(screen.getByLabelText('Text')).toHaveClass('input')
    expect(screen.getByLabelText('Pick')).toHaveClass('select')
    expect(screen.getByLabelText('Pick')).not.toHaveClass('input')
  })

  it('a select offers exactly the options given, in order', () => {
    render(<Select id="s" value="b" onChange={() => {}} aria-label="Pick" options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />)
    const select = screen.getByLabelText('Pick') as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual(['A', 'B'])
    expect(select.value).toBe('b')
  })
})

/** A controlled owner, so the box follows each emitted value the way a form does. */
function ControlledNumber({ initial, onChange }: { initial: number | null; onChange: (v: number | null) => void }) {
  const [value, setValue] = useState<number | null>(initial)
  return <NumberInput id="n" value={value} onChange={(v) => { setValue(v); onChange(v) }} aria-label="Cap" />
}

describe('NumberInput keeps null and zero apart', () => {
  it('shows an empty box for null, and emits null when the box is cleared, 0 for a typed zero', () => {
    const onChange = vi.fn()
    render(<ControlledNumber initial={null} onChange={onChange} />)
    const box = screen.getByLabelText('Cap')
    expect(box).toHaveValue(null)
    fireEvent.change(box, { target: { value: '0' } })
    expect(onChange).toHaveBeenLastCalledWith(0)
    expect(box).toHaveValue(0)
    fireEvent.change(box, { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith(null)
    expect(box).toHaveValue(null)
  })

  it('does not emit while the box holds text it cannot parse (badInput), so partial typing is kept', () => {
    // A browser reports a half typed number ("1e") as value "" with badInput set;
    // jsdom cannot produce that state itself, so the flag is set on the element.
    const onChange = vi.fn()
    render(<ControlledNumber initial={5} onChange={onChange} />)
    const box = screen.getByLabelText('Cap')
    Object.defineProperty(box, 'validity', { value: { badInput: true }, configurable: true })
    fireEvent.change(box, { target: { value: '' } })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('Toggle and Checkbox', () => {
  it('a toggle is a switch with its label as its accessible name and its own class', () => {
    const onChange = vi.fn()
    render(<Toggle id="tg" checked={false} onChange={onChange} label="Enabled" />)
    const sw = screen.getByRole('switch', { name: 'Enabled' })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    expect(sw).toHaveClass('toggle')
    fireEvent.click(sw)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('a checkbox is a real checkbox with its own class and a visible label', () => {
    const onChange = vi.fn()
    render(<Checkbox id="cb" checked={true} onChange={onChange} label="TX" />)
    const box = screen.getByRole('checkbox', { name: 'TX' })
    expect(box).toBeChecked()
    expect(box).toHaveClass('checkbox')
    fireEvent.click(box)
    expect(onChange).toHaveBeenCalledWith(false)
  })
})

describe('Button', () => {
  it('carries the variant class and looks like a control at rest; a destructive variant is its own class', () => {
    render(
      <>
        <Button variant="primary" onClick={() => {}}>Save</Button>
        <Button variant="danger" onClick={() => {}}>Delete</Button>
      </>
    )
    expect(screen.getByRole('button', { name: 'Save' })).toHaveClass('btn', 'btn-primary')
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('btn', 'btn-danger')
  })

  it('a busy button is disabled and says so', () => {
    render(<Button variant="primary" busy onClick={() => {}}>Save</Button>)
    const b = screen.getByRole('button')
    expect(b).toBeDisabled()
    expect(b).toHaveAttribute('aria-busy', 'true')
  })
})

describe('Outcome: working, still alive and failed are distinct (Dan, 2026-06-28)', () => {
  const at = (state: OutcomeState) => render(<Outcome state={state} />)

  it('working shows what started and how long it has been running, so a hang is visible', () => {
    at({ kind: 'working', label: 'Saving the buyer profile', startedAt: 1_000, now: 4_200 })
    expect(screen.getByRole('status')).toHaveTextContent('Saving the buyer profile')
    expect(screen.getByRole('status')).toHaveTextContent('3 s')
  })

  it('a stalled action past its limit reads as stalled, not as working', () => {
    at({ kind: 'working', label: 'Saving the buyer profile', startedAt: 0, now: 31_000, stalledAfterMs: 30_000 })
    expect(screen.getByRole('alert')).toHaveTextContent(/still waiting after 31 s/i)
  })

  it('done says what happened and failed says what went wrong, in different roles', () => {
    at({ kind: 'done', message: 'Buyer profile saved, version 4.' })
    expect(screen.getByRole('status')).toHaveTextContent('Buyer profile saved, version 4.')
    at({ kind: 'failed', message: 'The buyer ledger did not answer.' })
    expect(screen.getByRole('alert')).toHaveTextContent('The buyer ledger did not answer.')
  })

  it('idle renders nothing', () => {
    const { container } = at({ kind: 'idle' })
    expect(container).toBeEmptyDOMElement()
  })
})
