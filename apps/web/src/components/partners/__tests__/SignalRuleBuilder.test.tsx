/**
 * The response classification rule builder's condition picker (#1463, L611):
 * derived from the one operator vocabulary, so an operator the classifier
 * knows is always offered and a stored rule is always shown as itself.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { chooseOption, readSelect } from '@/components/ui/__tests__/_select'
import { SIGNAL_OPERATORS, SIGNAL_OPERATOR_LABELS } from '@bidspoke/buyer-profile'
import { SignalRuleBuilder, SIGNAL_SECTIONS } from '../SignalRuleBuilder'
import { parseRules } from '@/app/(app)/partners/partner-draft'

const REJECTION_ONLY = SIGNAL_SECTIONS.filter((s) => s.cat === 'rejection')

describe('SignalRuleBuilder body rule conditions', () => {
  it('offers every signal operator, in the vocabulary order and with its shared label', () => {
    const value = parseRules({ rejection_signals: [{ field: 'details[].message', any_item_word_prefix_ci: 'invalid' }] })
    render(<SignalRuleBuilder value={value} onChange={vi.fn()} sections={REJECTION_ONLY} />)
    // Ported from reading the native select's [value, label] pairs (#2137): the
    // shared Select lists labels, and the shared labels map one to one onto operators.
    const reading = readSelect(screen.getByLabelText('Condition'))
    expect(reading.options).toEqual(SIGNAL_OPERATORS.map((op) => SIGNAL_OPERATOR_LABELS[op]))
    expect(new Set(reading.options).size).toBe(SIGNAL_OPERATORS.length)
    expect(reading.selected).toBe(SIGNAL_OPERATOR_LABELS.any_item_word_prefix_ci)
    expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe('invalid')
  })

  it('switching to a list operator keeps the value box and asks for a comma separated list', () => {
    const onChange = vi.fn()
    const value = parseRules({ rejection_signals: [{ field: 'code', equals: 'x' }] })
    render(<SignalRuleBuilder value={value} onChange={onChange} sections={REJECTION_ONLY} />)
    chooseOption(screen.getByLabelText('Condition'), SIGNAL_OPERATOR_LABELS.any_item_contains)
    const next = onChange.mock.calls[0][0]
    expect(next.rejection[0]).toMatchObject({ kind: 'body', condition: 'any_item_contains', value: 'x' })
  })

  it('an HTTP status rule uses the same words for the conditions it shares with a body rule (L118)', () => {
    const value = parseRules({ transient_signals: [{ status_code: 503, body_field: 'error.code', in: ['BUSY'] }] })
    render(<SignalRuleBuilder value={value} onChange={vi.fn()} sections={SIGNAL_SECTIONS.filter((s) => s.cat === 'transient')} />)
    const reading = readSelect(screen.getByLabelText('Condition'))
    expect(reading.options).toEqual(['contains', 'is one of', 'is none of', 'is present'])
    expect(reading.selected).toBe('is one of')
  })
})

// #1458: the rule row is built from the shared controls, with its accessible names kept.
describe('SignalRuleBuilder rows use the shared controls', () => {
  it('every control in a rule row is a shared one, under the names the tests and screen readers use', () => {
    const value = parseRules({ transient_signals: [{ status_code: 503, body_field: 'error.code', in: ['BUSY'] }], permanent_signals: [{ field: 'code', equals: 'x' }] })
    render(<SignalRuleBuilder value={value} onChange={vi.fn()} sections={SIGNAL_SECTIONS.filter((s) => s.cat !== 'rejection')} />)
    for (const trigger of screen.getAllByLabelText('Rule kind')) expect(trigger).toHaveClass('select-trigger')
    for (const box of [...screen.getAllByLabelText('Field'), ...screen.getAllByLabelText('Value'), screen.getByLabelText('Body field'), screen.getByLabelText('Status code')]) expect(box).toHaveClass('input')
    expect(screen.getByLabelText('Status code')).toHaveValue(503)
    for (const b of screen.getAllByRole('button', { name: 'Remove rule' })) expect(b).toHaveClass('btn', 'btn-ghost')
  })
})
