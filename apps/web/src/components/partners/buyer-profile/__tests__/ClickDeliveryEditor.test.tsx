/**
 * A click delivery route's state picker (#1639) sits under no section heading of
 * its own, so its name must be shown, not only read by a screen reader: since
 * #2324 the picker hides its legend by default because the buyer profile's
 * States section heading names it there.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
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
})
