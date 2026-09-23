import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { handBackMeaning } from '../buyer-select-exits'
import { BuyerSelectNode } from '../BuyerSelectNode'

// #1490: deferred is the migration mechanism for the whole cutover and reads
// as "postpone" to anyone who has not read docs/nodes/buyer-select.md. The two
// exits that hand the lead back are explained on the term, in the node's mode.

describe('handBackMeaning (#1490)', () => {
  it('says decide only sends EVERY sell off lead to deferred, back to the rest of the workflow', () => {
    const text = handBackMeaning('deferred', { mode: 'decide_only' })
    expect(text).toMatch(/every sell off lead/i)
    expect(text).toMatch(/rest of the workflow/i)
    expect(text).not.toMatch(/postpone/i)
  })

  it('in live mode with a live share names the leads outside the share', () => {
    const text = handBackMeaning('deferred', { mode: 'live', live_percent_env: 'BUYER_SELECT_LIVE_PERCENT' })
    expect(text).toMatch(/outside the live share/i)
    expect(text).toMatch(/BUYER_SELECT_LIVE_PERCENT/)
  })

  it('in live mode with no live share does not claim a share exists', () => {
    const text = handBackMeaning('deferred', { mode: 'live' })
    expect(text).not.toMatch(/live share/i)
    expect(text).toMatch(/sell off condition cannot be read/i)
  })

  it('explains not applicable as a lead that is not for sale, whatever the mode', () => {
    for (const mode of ['decide_only', 'live']) {
      const text = handBackMeaning('not_applicable', { mode })
      expect(text).toMatch(/not a sell off lead/i)
      expect(text).toMatch(/rest of the workflow/i)
    }
  })
})

function renderCard(config: Record<string, unknown>) {
  const props = {
    id: 'n1',
    data: { namespace: 'buyer_select', label: '', config, isReachable: true },
    selected: false,
  } as unknown as NodeProps
  return render(<ReactFlowProvider><BuyerSelectNode {...props} /></ReactFlowProvider>)
}

describe('BuyerSelectNode hand back labels (#1490)', () => {
  it('makes deferred and not applicable keyboard reachable and described by their meaning', () => {
    renderCard({ mode: 'decide_only' })
    for (const [name, handle] of [['deferred', 'deferred'], ['not applicable', 'not_applicable']] as const) {
      const term = screen.getByRole('button', { name })
      expect(term.tabIndex).toBe(0)
      expect(term).toHaveAccessibleDescription(handBackMeaning(handle, { mode: 'decide_only' }))
    }
  })

  it('leaves sold and no sale as plain labels', () => {
    renderCard({ mode: 'decide_only' })
    expect(screen.queryByRole('button', { name: 'sold' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'no sale' })).toBeNull()
    expect(screen.getByText('sold')).toBeInTheDocument()
  })
})
