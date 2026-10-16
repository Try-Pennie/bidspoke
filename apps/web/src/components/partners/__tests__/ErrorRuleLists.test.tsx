/**
 * The Retry and Never retry lists (#2143, PM-11): the person's own rules, then
 * the defaults the engine classifies a failed call by when none of them match,
 * as fixed rows marked Default, and an Alert switch on each list.
 *
 * The default rows are read from DEFAULT_ERROR_RULES, the constant the engine's
 * classifier reads, through defaultErrorRowsFor, so the page cannot describe a
 * default the engine does not apply (L41, L107). A default that applies only to
 * Code node scripts never shows, and one that applies but cannot be a row is
 * named as not shown, with why.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { DEFAULT_ERROR_RULES, defaultErrorRowsFor, PARTNER_PAGE_ERROR_SCOPES } from '@bidspoke/buyer-profile'
import { parseRules } from '@/app/(app)/partners/partner-draft'
import { ErrorRuleLists } from '../ErrorRuleLists'

function renderLists(over: Partial<Parameters<typeof ErrorRuleLists>[0]> = {}) {
  const props = {
    value: parseRules(null),
    onChange: vi.fn(),
    alertRetried: true,
    onAlertRetried: vi.fn(),
    alertNotRetried: true,
    onAlertNotRetried: vi.fn(),
    ...over,
  }
  render(<ErrorRuleLists {...props} />)
  return props
}

const list = (name: string) => screen.getByRole('group', { name })
const defaultRows = (name: string) => within(list(name)).queryAllByTestId('default-error-row').map((r) => r.textContent)

describe('ErrorRuleLists', () => {
  it('lists each default under the list of its decision, marked Default, in the order the classifier applies them', () => {
    renderLists()
    const byDecision = (d: string) => DEFAULT_ERROR_RULES.filter((r) => r.decision === d && r.notShownBecause === null && r.appliesTo.some((s) => s !== 'code_node' && PARTNER_PAGE_ERROR_SCOPES.includes(s))).map((r) => `${r.label}Default`)
    expect(defaultRows('Retry when any of')).toEqual(byDecision('transient'))
    expect(defaultRows('Never retry when any of')).toEqual(byDecision('permanent'))
    expect(defaultRows('Retry when any of')).toEqual(['An HTML error page instead of data, at any statusDefault', 'HTTP 429Default', 'HTTP 502, 503 or 504Default', 'No answer: a network failure or a timeoutDefault'])
    expect(defaultRows('Never retry when any of')).toEqual(['Any other status from 400 upDefault', 'Any other unsuccessful statusDefault'])
  })

  it('shows the six rows defaultErrorRowsFor gives, and never a default that applies only to Code nodes', () => {
    renderLists()
    const rows = defaultErrorRowsFor(PARTNER_PAGE_ERROR_SCOPES)
    expect([...defaultRows('Retry when any of'), ...defaultRows('Never retry when any of')]).toHaveLength(rows.shown.length)
    expect(rows.shown).toHaveLength(6)
    for (const rule of DEFAULT_ERROR_RULES.filter((r) => r.appliesTo.every((s) => s === 'code_node'))) {
      expect(screen.queryByText(new RegExp(rule.label))).toBeNull()
    }
    expect(screen.queryByText(/Code node/)).toBeNull()
  })

  it('names the default that applies but cannot be a row, and says why, under its decision', () => {
    renderLists()
    const { notShown } = defaultErrorRowsFor(PARTNER_PAGE_ERROR_SCOPES)
    expect(notShown.map((r) => r.id)).toEqual(['saturated'])
    const note = within(list('Retry when any of')).getByText(/REQUEST_LIMIT_EXCEEDED/)
    expect(note).toHaveTextContent(`Not shown as a row: ${notShown[0].label}. ${notShown[0].notShownBecause}`)
    expect(within(list('Never retry when any of')).queryByText(/REQUEST_LIMIT_EXCEEDED/)).toBeNull()
  })

  it('puts the person\'s own rules above the defaults, and says they are checked first', () => {
    renderLists({ value: parseRules({ transient_signals: [{ field: 'error.code', equals: 'BUSY' }] }) })
    const retry = list('Retry when any of')
    const own = within(retry).getByLabelText('Field')
    const firstDefault = within(retry).getAllByTestId('default-error-row')[0]
    expect(own.compareDocumentPosition(firstDefault) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('Your rules are checked before the defaults. A decline is never an alert.')).toBeInTheDocument()
  })

  it('adds a rule to the list its button sits in', () => {
    const onChange = vi.fn()
    renderLists({ onChange })
    fireEvent.click(within(list('Never retry when any of')).getByRole('button', { name: /add rule/i }))
    const next = onChange.mock.calls[0][0]
    expect(next.permanent).toHaveLength(1)
    expect(next.transient).toHaveLength(0)
  })

  it('carries an Alert switch on each list, the partner\'s transient and permanent alert settings', () => {
    const p = renderLists({ alertRetried: true, alertNotRetried: false })
    const retried = within(list('Retry when any of')).getByRole('switch', { name: 'Alert on errors that are retried' })
    const notRetried = within(list('Never retry when any of')).getByRole('switch', { name: 'Alert on errors that are not retried' })
    expect(retried).toHaveAttribute('aria-checked', 'true')
    expect(notRetried).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(notRetried)
    expect(p.onAlertNotRetried).toHaveBeenCalledWith(true)
    fireEvent.click(retried)
    expect(p.onAlertRetried).toHaveBeenCalledWith(false)
  })
})
