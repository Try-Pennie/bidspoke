import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { BuyerClickSendNode } from '../BuyerClickSendNode'

// #1553: the node stores its partner by id, so the card must not print a raw id
// as if it were a name. After a run it names the slug the engine resolved.
const PARTNER_ID = '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70'

function renderCard(config: Record<string, unknown>, output?: Record<string, unknown>) {
  const props = {
    id: 'n1',
    data: {
      namespace: 'send_click',
      label: '',
      config,
      isReachable: true,
      executionStep: output ? { status: 'completed', output } : undefined,
    },
    selected: false,
  } as unknown as NodeProps
  return render(<ReactFlowProvider><BuyerClickSendNode {...props} /></ReactFlowProvider>)
}

describe('BuyerClickSendNode partner badge (#1553)', () => {
  it('says no partner when the config holds no partner id', () => {
    renderCard({})
    expect(screen.getByText('no partner')).toBeInTheDocument()
  })

  it('never prints the stored id as the partner name at rest', () => {
    renderCard({ partner_id: PARTNER_ID })
    expect(screen.queryByText(PARTNER_ID)).toBeNull()
    expect(screen.getByText('partner set')).toBeInTheDocument()
  })

  it('names the slug the last run resolved', () => {
    renderCard({ partner_id: PARTNER_ID }, { _route: 'sent', partner_id: PARTNER_ID, partner_slug: 'liberty1' })
    expect(screen.getByText('liberty1')).toBeInTheDocument()
  })
})
