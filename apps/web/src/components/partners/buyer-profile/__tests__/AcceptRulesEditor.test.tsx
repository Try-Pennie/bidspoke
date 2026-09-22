/**
 * The accept rules editor (#1412): the buyer_select accept signals on the
 * partner record, one row per rule, the operator a picker over the shared
 * SIGNAL_OPERATORS (L611), and the enable refusal for a missing rule rendered
 * beside this control (L111) rather than somewhere the person cannot act.
 */
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { SIGNAL_OPERATORS, type Signal } from '@bidspoke/buyer-profile'
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
    expect(within(rows[0]).getByLabelText(/operator/i)).toHaveValue('equals')
    expect(within(rows[0]).getByLabelText(/value/i)).toHaveValue('true')
    expect(within(rows[1]).getByLabelText(/operator/i)).toHaveValue('in')
    expect(within(rows[1]).getByLabelText(/value/i)).toHaveValue('1000,1001,1013')
  })

  it('offers exactly the shared operators, in the shared order', () => {
    render(<AcceptRulesEditor value={rules} onChange={() => {}} />)
    const select = within(screen.getAllByRole('group', { name: /accept rule/i })[0]).getByLabelText(/operator/i) as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual([...SIGNAL_OPERATORS])
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
    fireEvent.change(within(row).getByLabelText(/operator/i), { target: { value: 'in' } })
    expect(onChange).toHaveBeenLastCalledWith([{ field: 'ok', in: ['true'] }])
    fireEvent.change(within(row).getByLabelText(/value/i), { target: { value: '1000, 1001' } })
    expect(onChange).toHaveBeenLastCalledWith([{ field: 'ok', in: [1000, 1001] }])
    fireEvent.change(within(row).getByLabelText(/operator/i), { target: { value: 'present' } })
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

  it('renders the enable refusal beside the control, and an empty list says a 200 is never an accept', () => {
    render(<AcceptRulesEditor value={[]} onChange={() => {}} refusal="An enabled profile needs at least one accept rule." />)
    expect(screen.getByRole('alert')).toHaveTextContent('An enabled profile needs at least one accept rule.')
    expect(screen.getByText(/without a rule, no answer is an accept/i)).toBeInTheDocument()
  })
})
