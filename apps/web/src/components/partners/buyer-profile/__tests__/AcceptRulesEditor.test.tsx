/**
 * The accept rules editor (#1412): the buyer_select accept signals on the
 * partner record, one row per rule, the operator a picker over the shared
 * SIGNAL_OPERATORS (L611), and the enable refusal for a missing rule rendered
 * beside this control (L111) rather than somewhere the person cannot act.
 */
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { SIGNAL_OPERATORS, SIGNAL_OPERATOR_LABELS, type Signal } from '@bidspoke/buyer-profile'
import { chooseOption, readSelect } from '@/components/ui/__tests__/_select'
import { AcceptRulesEditor } from '../AcceptRulesEditor'

const rules: Signal[] = [
  { field: 'ok', equals: true },
  { field: 'data.createLead.resultCode', in: [1000, 1001, 1013] },
]

describe('AcceptRulesEditor', () => {
  it('renders one row per rule with the field, the operator and the value', () => {
    render(<AcceptRulesEditor value={rules} onChange={() => {}} />)
    const rows = screen.getAllByRole('group', { name: /accept rule/i })
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByLabelText(/field/i)).toHaveValue('ok')
    expect(readSelect(within(rows[0]).getByLabelText(/operator/i)).selected).toBe(SIGNAL_OPERATOR_LABELS.equals)
    expect(within(rows[0]).getByLabelText(/value/i)).toHaveValue('true')
    expect(readSelect(within(rows[1]).getByLabelText(/operator/i)).selected).toBe(SIGNAL_OPERATOR_LABELS.in)
    expect(within(rows[1]).getByLabelText(/value/i)).toHaveValue('1000,1001,1013')
  })

  // Ported from reading the native select's option values (#2137): the shared
  // Select lists labels, so the shared order is read through the shared labels.
  it('offers exactly the shared operators, in the shared order', () => {
    render(<AcceptRulesEditor value={rules} onChange={() => {}} />)
    const trigger = within(screen.getAllByRole('group', { name: /accept rule/i })[0]).getByLabelText(/operator/i)
    expect(readSelect(trigger).options).toEqual(SIGNAL_OPERATORS.map((o) => SIGNAL_OPERATOR_LABELS[o]))
  })

  it('emits a shared Signal for each edit: a list operator splits on commas and keeps numbers numeric, present takes no value', () => {
    const onChange = vi.fn()
    // A controlled owner, so each edit is made against the rule the previous one produced.
    function Owner() {
      const [value, setValue] = useState<Signal[]>([{ field: 'ok', equals: true }])
      return <AcceptRulesEditor value={value} onChange={(v) => { setValue(v); onChange(v) }} />
    }
    render(<Owner />)
    const row = screen.getByRole('group', { name: /accept rule/i })
    chooseOption(within(row).getByLabelText(/operator/i), SIGNAL_OPERATOR_LABELS.in)
    expect(onChange).toHaveBeenLastCalledWith([{ field: 'ok', in: ['true'] }])
    fireEvent.change(within(row).getByLabelText(/value/i), { target: { value: '1000, 1001' } })
    expect(onChange).toHaveBeenLastCalledWith([{ field: 'ok', in: [1000, 1001] }])
    chooseOption(within(row).getByLabelText(/operator/i), SIGNAL_OPERATOR_LABELS.present)
    expect(onChange).toHaveBeenLastCalledWith([{ field: 'ok', present: true }])
    expect(within(row).queryByLabelText(/value/i)).toBeNull()
  })

  it('adds and removes rules', () => {
    const onChange = vi.fn()
    render(<AcceptRulesEditor value={rules} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /add accept rule/i }))
    expect(onChange).toHaveBeenLastCalledWith([...rules, { field: '', equals: '' }])
    fireEvent.click(within(screen.getAllByRole('group', { name: /accept rule/i })[0]).getByRole('button', { name: /remove/i }))
    expect(onChange).toHaveBeenLastCalledWith([rules[1]])
  })

  // #2325: an empty set is a grey sentence as the design draws it, never an amber warning;
  // the refusal to enable without a rule is what speaks up.
  it('renders the enable refusal beside the control, and an empty list says no answer counts as a sale, in grey', () => {
    render(<AcceptRulesEditor value={[]} onChange={() => {}} refusal="An enabled profile needs at least one accept rule." />)
    expect(screen.getByRole('alert')).toHaveTextContent('An enabled profile needs at least one accept rule.')
    expect(screen.getByText('No rules. No answer counts as a sale.')).toHaveClass('text-hint')
  })

  // #2325: the set is titled by what a match does, and Field, Operator and Value are said once over its rows.
  it('is a set titled Accept when every one of, naming its columns once however many rules it has', () => {
    render(<AcceptRulesEditor value={rules} onChange={() => {}} />)
    const set = screen.getByRole('group', { name: 'Accept when every one of' })
    expect(within(set).getAllByText('Field')).toHaveLength(1)
    expect(within(set).getAllByText('Value')).toHaveLength(1)
  })

  // #1416: the same editor edits the duplicate rules, named as such everywhere a
  // screen reader or a test reaches it, and its empty state says what an empty
  // list means for THIS list: every decline is Fail, which is honest, not a gap.
  it('as the duplicate rules editor it names its rows and its add button as duplicate rules, and an empty list says every decline is Fail', () => {
    const onChange = vi.fn()
    render(<AcceptRulesEditor kind="duplicate" value={[]} onChange={onChange} />)
    expect(screen.queryByRole('group', { name: /accept rule/i })).toBeNull()
    expect(screen.getByText(/every decline is recorded as Fail/i)).toBeInTheDocument()
    expect(screen.queryByText(/no answer counts as a sale/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /add duplicate rule/i }))
    expect(onChange).toHaveBeenLastCalledWith([{ field: '', equals: '' }])
    render(<AcceptRulesEditor kind="duplicate" value={rules} onChange={onChange} />)
    expect(screen.getAllByRole('group', { name: /duplicate rule/i })).toHaveLength(2)
  })
})
