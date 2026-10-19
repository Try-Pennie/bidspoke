/**
 * The decline rules of a buyer's outcome rules (#2325, PM-22): the same rows
 * as the accept and duplicate sets, the columns named once, and a rule on the
 * HTTP status kept editable, with a way to add one, since the Bid Group reads
 * those (L677).
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { SignalRules } from '@/app/(app)/partners/partner-draft'
import { DeclineRulesEditor } from '../DeclineRulesEditor'

const rules: SignalRules = {
  rejection: [
    { id: 'a', kind: 'body', field: 'data.createLead.resultCode', condition: 'not_in', value: '1000,1001' },
    { id: 'b', kind: 'status', code: '422', bodyField: 'error', condition: 'contains', value: 'declined' },
  ],
  transient: [{ id: 't', kind: 'body', field: 'retry', condition: 'equals', value: 'true' }],
  permanent: [],
}

describe('DeclineRulesEditor', () => {
  it('draws body and status rules as rows under one set of column names', () => {
    render(<DeclineRulesEditor value={rules} onChange={() => {}} />)
    const set = screen.getByRole('group', { name: 'Decline when any of' })
    expect(within(set).getAllByText('Field')).toHaveLength(1)
    expect(within(set).getByRole('textbox', { name: 'Decline rule 1 field' })).toHaveValue('data.createLead.resultCode')
    expect(within(set).getByRole('spinbutton', { name: 'Decline rule 2 HTTP status' })).toHaveValue(422)
    expect(within(set).getByRole('textbox', { name: 'Decline rule 2 body field' })).toHaveValue('error')
  })

  it('edits, adds and removes only the decline rules, leaving the other groups as they are', () => {
    const onChange = vi.fn()
    render(<DeclineRulesEditor value={rules} onChange={onChange} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Decline rule 2 value' }), { target: { value: 'refused' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...rules, rejection: [rules.rejection[0], { ...rules.rejection[1], value: 'refused' }] })
    fireEvent.click(screen.getByRole('button', { name: 'Add HTTP status rule, decline' }))
    expect(onChange.mock.lastCall?.[0].rejection[2]).toMatchObject({ kind: 'status' })
    fireEvent.click(screen.getByRole('button', { name: 'Add rule, decline' }))
    expect(onChange.mock.lastCall?.[0].rejection[2]).toMatchObject({ kind: 'body' })
    fireEvent.click(screen.getByRole('button', { name: 'Remove decline rule 1' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...rules, rejection: [rules.rejection[1]] })
  })

  // Lessons review on #2325: a box's id follows its rule, so removing an earlier rule
  // does not move the ids (and what a label or a description points at) of the rest.
  it('removing a rule leaves the ids of the rules after it where they were', () => {
    const { rerender } = render(<DeclineRulesEditor value={rules} onChange={() => {}} />)
    const before = screen.getByRole('textbox', { name: 'Decline rule 2 body field' }).id
    rerender(<DeclineRulesEditor value={{ ...rules, rejection: [rules.rejection[1]] }} onChange={() => {}} />)
    expect(screen.getByRole('textbox', { name: 'Decline rule 1 body field' }).id).toBe(before)
  })

  it('with no rules says only No rules., in grey', () => {
    render(<DeclineRulesEditor value={{ ...rules, rejection: [] }} onChange={() => {}} />)
    expect(screen.getByText('No rules.')).toHaveClass('text-hint')
    expect(screen.queryByText('Field')).toBeNull()
  })
})
