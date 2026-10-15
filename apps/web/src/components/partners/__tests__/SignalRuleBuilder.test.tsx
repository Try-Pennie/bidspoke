/**
 * The response classification rule builder's condition picker (#1463, L611):
 * derived from the one operator vocabulary, so an operator the classifier
 * knows is always offered and a stored rule is always shown as itself.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SIGNAL_OPERATORS, SIGNAL_OPERATOR_LABELS } from '@bidspoke/buyer-profile'
import { SignalRuleBuilder, SIGNAL_SECTIONS } from '../SignalRuleBuilder'
import { parseRules } from '@/app/(app)/partners/partner-draft'

const REJECTION_ONLY = SIGNAL_SECTIONS.filter((s) => s.cat === 'rejection')

describe('SignalRuleBuilder body rule conditions', () => {
  it('offers every signal operator, in the vocabulary order and with its shared label', () => {
    const value = parseRules({ rejection_signals: [{ field: 'details[].message', any_item_word_prefix_ci: 'invalid' }] })
    render(<SignalRuleBuilder value={value} onChange={vi.fn()} sections={REJECTION_ONLY} />)
    const select = screen.getByLabelText('Condition') as HTMLSelectElement
    const options = Array.from(select.options).map((o) => [o.value, o.textContent])
    expect(options).toEqual(SIGNAL_OPERATORS.map((op) => [op, SIGNAL_OPERATOR_LABELS[op]]))
    expect(select.value).toBe('any_item_word_prefix_ci')
    expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe('invalid')
  })

  it('switching to a list operator keeps the value box and asks for a comma separated list', () => {
    const onChange = vi.fn()
    const value = parseRules({ rejection_signals: [{ field: 'code', equals: 'x' }] })
    render(<SignalRuleBuilder value={value} onChange={onChange} sections={REJECTION_ONLY} />)
    fireEvent.change(screen.getByLabelText('Condition'), { target: { value: 'any_item_contains' } })
    const next = onChange.mock.calls[0][0]
    expect(next.rejection[0]).toMatchObject({ kind: 'body', condition: 'any_item_contains', value: 'x' })
  })

  it('an HTTP status rule uses the same words for the conditions it shares with a body rule (L118)', () => {
    const value = parseRules({ transient_signals: [{ status_code: 503, body_field: 'error.code', in: ['BUSY'] }] })
    render(<SignalRuleBuilder value={value} onChange={vi.fn()} sections={SIGNAL_SECTIONS.filter((s) => s.cat === 'transient')} />)
    const select = screen.getByLabelText('Condition') as HTMLSelectElement
    const options = Array.from(select.options).map((o) => [o.value, o.textContent])
    expect(options).toEqual([['contains', 'contains'], ['in', 'is one of'], ['not_in', 'is none of'], ['present', 'is present']])
    expect(select.value).toBe('in')
  })
})
