import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import RuleBuilder from '../RuleBuilder'
import type { ConditionGroup } from '@/types/workflow'
import { CONDITION_OPERATORS, CONDITION_OPERATOR_SPECS } from '@bidspoke/workflow-definition'

// Characterization tests (#239) for the Filter/Branch rule builder. RuleBuilder is
// controlled: it never mutates its own state, it calls onChange with the next
// (groups, logic). So each test asserts the arguments handed to onChange, and
// renders the "after" state directly when it needs to assert what's visible.
function group(...conds: ConditionGroup['conditions']): ConditionGroup {
  return { conditions: conds, logic: 'AND' }
}
const lastGroups = (onChange: ReturnType<typeof vi.fn>): ConditionGroup[] =>
  onChange.mock.calls.at(-1)![0]

describe('RuleBuilder', () => {
  it('renders an existing condition: field, operator, and value', () => {
    const onChange = vi.fn()
    render(
      <RuleBuilder
        groups={[group({ field: 'amount', operator: 'gt', value: 5 })]}
        logic="AND"
        onChange={onChange}
      />,
    )
    expect(screen.getByDisplayValue('amount')).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toHaveValue('gt')
    expect(screen.getByPlaceholderText('value')).toHaveValue('5')
  })

  it('coerces a numeric value to a number for numeric operators', () => {
    const onChange = vi.fn()
    render(
      <RuleBuilder
        groups={[group({ field: 'amount', operator: 'gt', value: '' })]}
        logic="AND"
        onChange={onChange}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: '42' } })
    expect(lastGroups(onChange)[0].conditions[0].value).toBe(42)
  })

  it('keeps a non-numeric value as a string for "contains"', () => {
    const onChange = vi.fn()
    render(
      <RuleBuilder
        groups={[group({ field: 'name', operator: 'contains', value: '' })]}
        logic="AND"
        onChange={onChange}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: 'penny' } })
    expect(lastGroups(onChange)[0].conditions[0].value).toBe('penny')
  })

  it('hides the value input for a value-less operator', () => {
    render(
      <RuleBuilder
        groups={[group({ field: 'flag', operator: 'is_true', value: '' })]}
        logic="AND"
        onChange={vi.fn()}
      />,
    )
    expect(screen.queryByPlaceholderText('value')).not.toBeInTheDocument()
  })

  it('changing the operator re-coerces the existing value', () => {
    const onChange = vi.fn()
    render(
      <RuleBuilder
        groups={[group({ field: 'amount', operator: 'eq', value: '7' })]}
        logic="AND"
        onChange={onChange}
      />,
    )
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'gt' } })
    const cond = lastGroups(onChange)[0].conditions[0]
    expect(cond.operator).toBe('gt')
    expect(cond.value).toBe(7)
  })

  it('adds a condition to the group', () => {
    const onChange = vi.fn()
    render(
      <RuleBuilder
        groups={[group({ field: 'a', operator: 'eq', value: '1' })]}
        logic="AND"
        onChange={onChange}
      />,
    )
    fireEvent.click(screen.getByText('Add condition'))
    expect(lastGroups(onChange)[0].conditions).toHaveLength(2)
  })

  it('adds a second group', () => {
    const onChange = vi.fn()
    render(
      <RuleBuilder
        groups={[group({ field: 'a', operator: 'eq', value: '1' })]}
        logic="AND"
        onChange={onChange}
      />,
    )
    fireEvent.click(screen.getByText('Add group'))
    expect(lastGroups(onChange)).toHaveLength(2)
  })

  it('removing the last condition in a group removes the group', () => {
    const onChange = vi.fn()
    render(
      <RuleBuilder
        groups={[group({ field: 'a', operator: 'eq', value: '1' })]}
        logic="AND"
        onChange={onChange}
      />,
    )
    // With a single group, the only icon-only (no text) button is the condition's
    // trash; "Add condition" / "Add group" carry text, and the group-level trash
    // is hidden until there's more than one group.
    const trash = screen.getAllByRole('button').filter((b) => b.textContent === '')
    expect(trash).toHaveLength(1)
    fireEvent.click(trash[0])
    expect(lastGroups(onChange)).toHaveLength(0)
  })

  // #2588's editor half: the dropdown reads the one shared operator list, so the
  // two lead validation operators appear under the names Dan settled (#2590).
  it('offers every shared operator, in list order, with its shared label', () => {
    render(
      <RuleBuilder groups={[group({ field: 'a', operator: 'eq', value: '1' })]} logic="AND" onChange={vi.fn()} />,
    )
    const options = Array.from(screen.getByRole('combobox').querySelectorAll('option'))
    expect(options.map((o) => o.value)).toEqual([...CONDITION_OPERATORS])
    expect(options.map((o) => o.textContent)).toEqual(CONDITION_OPERATORS.map((op) => CONDITION_OPERATOR_SPECS[op].label))
    expect(options.at(-2)?.textContent).toBe('contains a letter')
    expect(options.at(-1)?.textContent).toBe('is not empty')
  })

  it.each(['has_letter', 'not_blank'] as const)('hides the value input for %s, which reads only the field', (operator) => {
    render(<RuleBuilder groups={[group({ field: 'firstName', operator, value: '' })]} logic="AND" onChange={vi.fn()} />)
    expect(screen.queryByPlaceholderText('value')).not.toBeInTheDocument()
  })

  it('keeps a reference typed into a numeric operator as the string, so the engine can resolve it', () => {
    const onChange = vi.fn()
    render(<RuleBuilder groups={[group({ field: 'loanAmount', operator: 'lte', value: '' })]} logic="AND" onChange={onChange} />)
    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: 'steps.constants.output.maximumLoanAmount' } })
    expect(lastGroups(onChange)[0].conditions[0].value).toBe('steps.constants.output.maximumLoanAmount')
  })

  it('keeps typed text as it is for a stored operator the list does not hold, rather than failing', () => {
    const onChange = vi.fn()
    const stored = { field: 'a', operator: 'constructor' as unknown as 'eq', value: '' }
    render(<RuleBuilder groups={[group(stored)]} logic="AND" onChange={onChange} />)
    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: '42' } })
    expect(lastGroups(onChange)[0].conditions[0].value).toBe('42')
  })
})
