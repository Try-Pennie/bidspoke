import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DegradedBanner } from '../DegradedBanner'

// #356: warn on the dashboard when the degraded share (lead served, post-response
// Salesforce writeback failed) is elevated — it otherwise hides behind a green
// success rate.
describe('DegradedBanner', () => {
  it('renders nothing when the degraded share is below the threshold', () => {
    const { container } = render(<DegradedBanner degraded={2} total={100} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when there are no runs', () => {
    const { container } = render(<DegradedBanner degraded={0} total={0} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('warns when the degraded share is at or above the threshold, with the count and percent', () => {
    render(<DegradedBanner degraded={8} total={100} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('8 of 100')
    expect(alert).toHaveTextContent('8%')
  })

  it('explains what degraded means and gives an actionable next step', () => {
    render(<DegradedBanner degraded={10} total={100} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/writeback failed/i)
    expect(alert).toHaveTextContent(/How to fix/i)
  })
})
