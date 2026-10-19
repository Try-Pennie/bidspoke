/**
 * Every buyer profile rule button that shows words carries those words in its
 * accessible name (#2477, WCAG 2.5.3 label in name, axe label-content-name-mismatch),
 * so a voice control user saying what they see reaches it (L786). The context a
 * screen reader needs (which list the rule goes into) comes after the visible words.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { SignalRules } from '@/app/(app)/partners/partner-draft'
import { AcceptRulesEditor } from '../AcceptRulesEditor'
import { DeclineRulesEditor } from '../DeclineRulesEditor'

const normal = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

function expectEveryNamedButtonCarriesItsText() {
  const buttons = screen.getAllByRole('button').filter((b) => normal(b.textContent ?? '') !== '')
  expect(buttons.length).toBeGreaterThan(0)
  for (const b of buttons) {
    const name = b.getAttribute('aria-label') ?? b.textContent ?? ''
    expect(normal(name), `button showing "${normal(b.textContent ?? '')}"`).toContain(normal(b.textContent ?? ''))
  }
}

const decline: SignalRules = { rejection: [], transient: [], permanent: [] }

describe('rule buttons name what they show (#2477)', () => {
  it.each(['accept', 'duplicate'] as const)('the %s rules editor', (kind) => {
    render(<AcceptRulesEditor kind={kind} value={[]} onChange={() => {}} />)
    expectEveryNamedButtonCarriesItsText()
  })

  it('the decline rules editor', () => {
    render(<DeclineRulesEditor value={decline} onChange={() => {}} />)
    expectEveryNamedButtonCarriesItsText()
  })
})
