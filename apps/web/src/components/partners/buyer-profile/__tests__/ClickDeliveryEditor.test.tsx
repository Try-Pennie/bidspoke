/**
 * A click delivery route's state picker (#1639) sits under no section heading of
 * its own, so its name must be shown, not only read by a screen reader: since
 * #2324 the picker hides its legend by default because the buyer profile's
 * States section heading names it there.
 */
import { describe, expect, it } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ClickDeliveryDocument } from '@bidspoke/buyer-profile'
import { ClickDeliveryEditor } from '../ClickDeliveryEditor'

describe('ClickDeliveryEditor', () => {
  it("shows each route's state picker name on screen", () => {
    render(
      <ClickDeliveryEditor
        value={{ routes: [{ name: 'Texas', url: 'https://example.com/{prospect_id}', states: ['TX'] }], success_pattern: '' }}
        onChange={() => {}}
      />,
    )
    const legend = screen.getByText('States for Texas')
    expect(legend.tagName).toBe('LEGEND')
    expect(legend).not.toHaveClass('sr-only')
    expect(screen.getByRole('group', { name: 'States for Texas' })).toBeInTheDocument()
  })

  // Lessons review on #2325: a route whose chips are on screen keeps them when its last
  // state is unticked, so None does not snatch the picker away mid edit.
  it('a route keeps its chips when None clears its last state', () => {
    function Owner() {
      const [value, setValue] = useState<ClickDeliveryDocument | null>({ routes: [{ name: 'DV1', url: 'https://example.com/{prospect_id}', states: ['OR'] }], success_pattern: '' })
      return <ClickDeliveryEditor value={value} onChange={setValue} />
    }
    render(<Owner />)
    const picker = screen.getByRole('group', { name: 'States for DV1' })
    fireEvent.click(within(picker).getByRole('button', { name: 'None' }))
    expect(screen.getByRole('group', { name: 'States for DV1' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'OR' })).not.toHaveClass('chip-on')
  })
})
