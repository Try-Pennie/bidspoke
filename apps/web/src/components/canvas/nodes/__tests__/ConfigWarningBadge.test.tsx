import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConfigWarningBadge } from '../ConfigWarningBadge'

// The badge is the ONLY thing that tells an unconfigured node apart from a
// timeout-warning node on the canvas (#563): both pulse, and the glow itself is
// aria-hidden + pointer-events-none, so it can't carry a tooltip.

describe('ConfigWarningBadge', () => {
  it('renders nothing for a healthy node', () => {
    const { container } = render(<ConfigWarningBadge hasError={false} message="No script written" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names the specific missing config in its tooltip, so the reason is visible on hover', () => {
    render(<ConfigWarningBadge hasError message="No script written" />)
    const badge = screen.getByRole('img')
    expect(badge.getAttribute('title')).toContain('No script written')
  })

  it('says the node is unconfigured, not that it has a timeout problem', () => {
    render(<ConfigWarningBadge hasError message="No script written" />)
    const title = screen.getByRole('img').getAttribute('title') ?? ''
    expect(title.toLowerCase()).toContain('not configured')
    expect(title.toLowerCase()).not.toContain('timeout')
  })

  it('falls back to a generic reason when validation gave no message', () => {
    render(<ConfigWarningBadge hasError />)
    const title = screen.getByRole('img').getAttribute('title') ?? ''
    expect(title.toLowerCase()).toContain('not configured')
  })

  it('exposes the reason to assistive tech, not just as a hover tooltip', () => {
    render(<ConfigWarningBadge hasError message="No condition field set" />)
    expect(screen.getByRole('img', { name: /No condition field set/ })).toBeTruthy()
  })
})
