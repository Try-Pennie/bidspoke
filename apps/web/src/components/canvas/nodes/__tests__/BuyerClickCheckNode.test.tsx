import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { BuyerClickCheckNode } from '../BuyerClickCheckNode'

// #1543: the node stores its buyer by id, so the card never prints the raw id as
// a name; after a run it names the buyer the check resolved and what it decided,
// with the count and the cap it judged, in the plain reason labels.
const PARTNER_ID = '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70'

function renderCard(config: Record<string, unknown>, output?: Record<string, unknown>) {
  const props = {
    id: 'n1',
    data: {
      namespace: 'liberty1_check',
      label: '',
      config,
      isReachable: true,
      executionStep: output ? { status: 'completed', output } : undefined,
    },
    selected: false,
  } as unknown as NodeProps
  return render(<ReactFlowProvider><BuyerClickCheckNode {...props} /></ReactFlowProvider>)
}

describe('BuyerClickCheckNode', () => {
  it('says no partner when the config holds no partner id', () => {
    renderCard({})
    expect(screen.getByText('no partner')).toBeInTheDocument()
  })

  it('never prints the stored id as the partner name at rest', () => {
    renderCard({ partner_id: PARTNER_ID })
    expect(screen.queryByText(PARTNER_ID)).toBeNull()
    expect(screen.getByText('partner set')).toBeInTheDocument()
  })

  it('labels both handles', () => {
    renderCard({ partner_id: PARTNER_ID })
    expect(screen.getByText('eligible')).toBeInTheDocument()
    expect(screen.getByText('not eligible')).toBeInTheDocument()
  })

  it('after an eligible run names the buyer and the clicks judged against the cap', () => {
    renderCard({ partner_id: PARTNER_ID }, { _route: 'eligible', reason: 'eligible', partner_slug: 'liberty1', partner_name: 'Liberty1', count: 12, daily_lead_cap: 50 })
    expect(screen.getByText('Liberty1')).toBeInTheDocument()
    expect(screen.getByText('eligible, 12 of 50 clicks today')).toBeInTheDocument()
  })

  it('after a not eligible run shows the reason in its plain label', () => {
    renderCard({ partner_id: PARTNER_ID }, { _route: 'not_eligible', reason: 'daily_lead_cap', partner_name: 'Liberty1', count: 50, daily_lead_cap: 50 })
    expect(screen.getByText('not eligible: Daily lead cap reached')).toBeInTheDocument()
  })
})
