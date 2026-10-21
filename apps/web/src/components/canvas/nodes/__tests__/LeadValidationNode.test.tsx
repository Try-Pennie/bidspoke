import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { ComponentType } from 'react'
import { baseNodeTypes } from '../registry'
import { leadValidationFixtureConfig, LEAD_VALIDATION_FIXTURE } from '@/lib/__tests__/_lead-validation-fixture'

// The lead validation step's card, as Dan settled it on 2026-10-21
// (docs/design/lead-validation-node-card.html): C1, under its title and step id
// it says how many checks it runs and nothing more; C2, a slate header; C3, one
// way out, labelled pass. The registry entry is rendered, so the card the canvas
// draws is the card tested. The colours are measured in a browser by the
// settled checks file; here the classes that carry them are pinned.
function renderCard(config: Record<string, unknown>, label = LEAD_VALIDATION_FIXTURE.node.title) {
  const Card = baseNodeTypes.lead_validation as ComponentType<NodeProps>
  const props = {
    id: 'v',
    type: 'lead_validation',
    data: { namespace: LEAD_VALIDATION_FIXTURE.node.id, label, config, isReachable: true },
    selected: false,
  } as unknown as NodeProps
  return render(<ReactFlowProvider><Card {...props} /></ReactFlowProvider>)
}

/** Every line of text in the card below its header, in order. */
function linesBelowHeader(container: HTMLElement): string[] {
  const header = container.querySelector('[data-card-header]')!
  return [...container.querySelectorAll('p, span')]
    .filter((e) => !header.contains(e) && e.children.length === 0 && (e.textContent ?? '').trim() !== '')
    .map((e) => (e.textContent ?? '').trim())
}

describe('the lead validation card', () => {
  it('reads its title, its step id, how many checks it runs, then its one way out (C1, C3)', () => {
    const { container } = renderCard(leadValidationFixtureConfig())
    expect(linesBelowHeader(container)).toEqual(['Validate bidding and state', 'validate_bidding_and_state', '7 checks', '↓ pass'])
  })

  it('says one check in the singular, and no checks when there are none', () => {
    const one = leadValidationFixtureConfig()
    one.checks = one.checks.slice(0, 1)
    expect(linesBelowHeader(renderCard(one).container)).toContain('1 check')
    expect(linesBelowHeader(renderCard({ ...one, checks: [] }).container)).toContain('No checks')
  })

  it('draws its header in slate: 50 behind, 100 for the rule, 700 for the label (C2)', () => {
    const { container } = renderCard(leadValidationFixtureConfig())
    const header = container.querySelector('[data-card-header]')!
    expect(header.className).toMatch(/\bbg-slate-50\b/)
    expect(header.className).toMatch(/\bborder-slate-100\b/)
    const label = [...header.querySelectorAll('span')].find((s) => s.textContent === 'Lead validation')!
    expect(label.className).toMatch(/\btext-slate-700\b/)
  })

  it('has one source handle, the pass through output, at the centre', () => {
    const { container } = renderCard(leadValidationFixtureConfig())
    const handles = [...container.querySelectorAll<HTMLElement>('.react-flow__handle.source')]
    expect(handles.map((h) => h.getAttribute('data-handleid'))).toEqual(['output'])
  })
})
