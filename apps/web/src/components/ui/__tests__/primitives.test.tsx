/**
 * The design system form primitives (#1412, L607). Every control the buyer
 * profile section renders comes from here, with its own class so the
 * geometry can differ by control (a select is not an input), a real label
 * reachable by keyboard and screen reader, and the three states an action can
 * be in (working, still alive, failed) told apart at a glance.
 */
import { describe, expect, it, vi } from 'vitest'
import { useState, type ReactNode } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Field, FieldError, TextInput, NumberInput, Checkbox, Button, Outcome, ChoiceGroup, type OutcomeState } from '../form'
import { Toggle } from '../Toggle'
import { Select } from '../Select'
import { chooseOption, readSelect } from './_select'

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

  it('draws the hint in the hint token and the error through FieldError (#2144)', () => {
    render(
      <Field id="g" label="Cap" hint="Leads a day." error="Cap must be a whole number.">
        <TextInput id="g" value="" onChange={() => {}} />
      </Field>
    )
    expect(screen.getByText('Leads a day.')).toHaveClass('text-hint')
    expect(screen.getByText('Leads a day.')).not.toHaveClass('text-gray-500')
    expect(screen.getByRole('alert')).toHaveClass('field-error', 'text-xs')
  })
})

describe('FieldError (#2144)', () => {
  it('is quiet unless asked to announce, takes the size around it unless given one, and can stand on its own panel', () => {
    render(
      <>
        <FieldError>Could not be read</FieldError>
        <FieldError alert size="sm" boxed as="div" className="mb-4">The partners could not be loaded.</FieldError>
      </>
    )
    const quiet = screen.getByText('Could not be read')
    expect(quiet.tagName).toBe('P')
    expect(quiet).not.toHaveAttribute('role')
    expect(quiet.className).toBe('field-error')
    const loud = screen.getByRole('alert')
    expect(loud.tagName).toBe('DIV')
    expect(loud).toHaveClass('field-error', 'text-sm', 'field-error-box', 'mb-4')
  })
})

describe('TextInput and Select carry their own classes', () => {
  it('a text input is .input and a select is .select-trigger, never the same class', () => {
    render(
      <>
        <TextInput id="t" value="x" onChange={() => {}} aria-label="Text" />
        <Select id="s" value="a" onChange={() => {}} aria-label="Pick" options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />
      </>
    )
    expect(screen.getByLabelText('Text')).toHaveClass('input')
    expect(screen.getByLabelText('Pick')).toHaveClass('select-trigger')
    expect(screen.getByLabelText('Pick')).not.toHaveClass('input')
  })

  // Ported from the native select's "offers exactly the options given, in order",
  // which read select.options and select.value (#2137).
  it('a select offers exactly the options given, in order, with the chosen one marked', () => {
    render(<Select id="s" value="b" onChange={() => {}} aria-label="Pick" options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />)
    expect(readSelect(screen.getByLabelText('Pick'))).toEqual({ options: ['A', 'B'], selected: 'B', shown: 'B' })
  })

  it('a person choosing an option reports its value once', () => {
    const onChange = vi.fn()
    render(<Select id="s" value="a" onChange={onChange} aria-label="Pick" options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />)
    chooseOption(screen.getByLabelText('Pick'), 'B')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('a pointer press opens the list, as a mouse does', async () => {
    render(<Select id="s" value="a" onChange={() => {}} aria-label="Pick" options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />)
    await userEvent.click(screen.getByLabelText('Pick'))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('a text input offers its suggestions without limiting what is typed', () => {
    render(<TextInput id="path" value="" onChange={() => {}} aria-label="Path" suggestions={['data.id', 'data.code']} />)
    expect(screen.getByLabelText('Path')).toHaveAttribute('list', 'path-suggestions')
    expect([...document.querySelectorAll('#path-suggestions option')].map((o) => o.getAttribute('value'))).toEqual(['data.id', 'data.code'])
  })
})

describe('Select keeps the value contract its callers rely on (#2137)', () => {
  const WORKFLOWS = [{ value: '', label: 'All workflows' }, { value: 'wf-1', label: 'Main Flow' }]

  it("'' is a real option value: it shows its label and can be chosen back", () => {
    const onChange = vi.fn()
    const { rerender } = render(<Select id="s" value="" onChange={onChange} aria-label="Used by" options={WORKFLOWS} />)
    expect(readSelect(screen.getByLabelText('Used by'))).toEqual({ options: ['All workflows', 'Main Flow'], selected: 'All workflows', shown: 'All workflows' })
    rerender(<Select id="s" value="wf-1" onChange={onChange} aria-label="Used by" options={WORKFLOWS} />)
    chooseOption(screen.getByLabelText('Used by'), 'All workflows')
    expect(onChange).toHaveBeenCalledWith('')
  })

  it("shows the placeholder for '' when no option stands for ''", () => {
    render(<Select id="s" value="" onChange={() => {}} aria-label="Matrix" placeholder="Select a matrix" options={[{ value: 'm1', label: 'Default' }]} />)
    expect(screen.getByLabelText('Matrix')).toHaveTextContent('Select a matrix')
    expect(readSelect(screen.getByLabelText('Matrix')).selected).toBeNull()
  })

  it('a stored value the options no longer offer shows as no longer available, never blank, and stays the value', () => {
    const onChange = vi.fn()
    render(<form><Select id="s" value="gone_op" onChange={onChange} aria-label="Operator" options={[{ value: 'equals', label: 'equals' }]} /></form>)
    const reading = readSelect(screen.getByLabelText('Operator'))
    expect(reading.shown).toBe('gone_op (no longer available)')
    expect(reading.options).toEqual(['gone_op (no longer available)', 'equals'])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a change on the hidden form select is not a person choosing, so it never rewrites the value', () => {
    const onChange = vi.fn()
    const { container } = render(
      <form>
        <Select id="s" value="gone_op" onChange={onChange} aria-label="Operator" name="operator" options={[{ value: 'equals', label: 'equals' }]} />
      </form>
    )
    // The form submits the stored value under its name, missing from the options or not.
    expect(new FormData(container.querySelector('form')!).get('operator')).toBe('gone_op')
    const hidden = container.querySelector('select[aria-hidden="true"]') as HTMLSelectElement
    expect(hidden).not.toBeNull()
    // What a browser reports when the hidden select cannot hold a value: empty.
    fireEvent.change(hidden, { target: { value: '' } })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Operator')).toHaveTextContent('gone_op (no longer available)')
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

  it('a toggle in a form submits under its name as a checkbox does: "on" when on, nothing when off', () => {
    const { container, rerender } = render(<form><Toggle id="tg" name="enabled" checked onChange={() => {}} label="Enabled" /></form>)
    expect(new FormData(container.querySelector('form')!).get('enabled')).toBe('on')
    rerender(<form><Toggle id="tg" name="enabled" checked={false} onChange={() => {}} label="Enabled" /></form>)
    expect(new FormData(container.querySelector('form')!).get('enabled')).toBeNull()
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

// #1541: a choice between a few named answers, where no answer may be
// preselected: a radio group, one tab stop, arrows move and choose (L560).
describe('ChoiceGroup', () => {
  const options = [{ value: 'offer', label: 'The offer' }, { value: 'click', label: 'The click' }] as const

  function Controlled({ initial, onChange, disabled }: { initial: 'offer' | 'click' | null; onChange?: (v: string) => void; disabled?: boolean }) {
    const [value, setValue] = useState<'offer' | 'click' | null>(initial)
    return <ChoiceGroup id="kind" label="Sold on" value={value} options={options} onChange={(v) => { setValue(v); onChange?.(v) }} disabled={disabled} describedBy="kind-hint" />
  }

  it('is a labelled radio group whose children are radios, none checked when nothing was chosen', () => {
    render(<Controlled initial={null} />)
    const group = screen.getByRole('radiogroup', { name: 'Sold on' })
    expect(group).toHaveClass('choice-group')
    expect(group).toHaveAttribute('aria-describedby', 'kind-hint')
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.textContent)).toEqual(['The offer', 'The click'])
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false'])
    // One tab stop even with no answer: the first option.
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1])
  })

  // #2134: under a heading that already says it, the label is shortened or
  // hidden on screen and the group is still named in full.
  it('shows a shorter label without changing the group\'s name, or none at all', () => {
    const options = [{ value: 'a', label: 'A' }] as const
    const { unmount } = render(<ChoiceGroup id="m" label="Hours, Monday" visibleLabel="Monday" value={null} options={options} onChange={() => {}} />)
    expect(screen.getByRole('radiogroup', { name: 'Hours, Monday' })).toBeInTheDocument()
    expect(screen.getByText('Monday')).toBeVisible()
    unmount()
    render(<ChoiceGroup id="b" label="Blackout dates" visibleLabel="" value={null} options={options} onChange={() => {}} />)
    expect(screen.getByRole('radiogroup', { name: 'Blackout dates' })).toBeInTheDocument()
    expect(document.getElementById('b-label')).toHaveClass('sr-only')
  })

  it('a click chooses, marks the choice checked and makes it the tab stop', () => {
    const onChange = vi.fn()
    render(<Controlled initial={null} onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: 'The click' }))
    expect(onChange).toHaveBeenCalledWith('click')
    expect(screen.getByRole('radio', { name: 'The click' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'The click' })).toHaveClass('choice-on')
    expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toEqual([-1, 0])
  })

  it('arrow keys move to the next option and choose it, wrapping at the ends', () => {
    const onChange = vi.fn()
    render(<Controlled initial="offer" onChange={onChange} />)
    fireEvent.keyDown(screen.getByRole('radio', { name: 'The offer' }), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('click')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'The click' }))
    fireEvent.keyDown(screen.getByRole('radio', { name: 'The click' }), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('offer')
    fireEvent.keyDown(screen.getByRole('radio', { name: 'The offer' }), { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('click')
  })

  it('a disabled group changes nothing on a click or a key', () => {
    const onChange = vi.fn()
    render(<Controlled initial="offer" onChange={onChange} disabled />)
    fireEvent.click(screen.getByRole('radio', { name: 'The click' }))
    fireEvent.keyDown(screen.getByRole('radio', { name: 'The offer' }), { key: 'ArrowRight' })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('radio', { name: 'The offer' })).toHaveAttribute('aria-checked', 'true')
  })

  it('stacked, each option carries its hint under its label', () => {
    render(<ChoiceGroup id="src" label="Where does the bid value come from?" value="a" stacked onChange={() => {}} options={[{ value: 'a', label: 'The API response', hint: 'Read from the reply.' }, { value: 'b', label: 'A formula' }]} />)
    expect(screen.getByRole('radiogroup')).toHaveClass('choice-stack')
    expect(screen.getByRole('radio', { name: 'The API response' })).toHaveAccessibleDescription('Read from the reply.')
    expect(screen.getByRole('radio', { name: /The API response/ })).toHaveClass('choice-row-on')
  })
})

// Enter commits or opens a control and never submits the form around it (L596,
// #2137). The fixture has a real submit button, and its positive control proves
// Enter CAN submit this form, so a green run is a measurement.
describe('Enter never submits the form from a shared control', () => {
  function Fixture({ onSubmit, children }: { onSubmit: () => void; children: ReactNode }) {
    return (
      <form onSubmit={(e) => { e.preventDefault(); onSubmit() }}>
        {children}
        <button type="submit">Save</button>
      </form>
    )
  }

  it('positive control: Enter in a plain text box does submit this form', async () => {
    const onSubmit = vi.fn()
    render(<Fixture onSubmit={onSubmit}><input aria-label="Plain" defaultValue="" /></Fixture>)
    await userEvent.type(screen.getByLabelText('Plain'), 'x{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('Enter on a Select opens it and does not submit', async () => {
    const onSubmit = vi.fn()
    render(<Fixture onSubmit={onSubmit}><Select id="s" value="a" onChange={() => {}} aria-label="Pick" options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} /></Fixture>)
    const trigger = screen.getByLabelText('Pick')
    // Radix's own key handler keeps Enter from the form even on a submit button,
    // so the type is asserted too: a submit typed trigger would submit on a click.
    expect(trigger).toHaveAttribute('type', 'button')
    trigger.focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('Enter on a Toggle does not submit', async () => {
    const onSubmit = vi.fn()
    render(<Fixture onSubmit={onSubmit}><Toggle id="tg" checked={false} onChange={() => {}} label="Enabled" /></Fixture>)
    screen.getByRole('switch', { name: 'Enabled' }).focus()
    await userEvent.keyboard('{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
