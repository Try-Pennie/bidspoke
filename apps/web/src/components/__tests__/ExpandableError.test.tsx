import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExpandableError } from '../ExpandableError'

// Error bodies (e.g. an Equifax 500 with a large additionalErrorDetails block)
// are now stored in full. The detail view must show them whole — never
// truncating the data — but collapse long ones behind a "Show more" toggle so a
// huge body doesn't blow out the page. See issue: code-node error truncation.
describe('ExpandableError', () => {
  const short = 'Connection refused'
  const long = 'Code returned error response: HTTP 500 — ' + 'x'.repeat(1000)

  it('renders short errors without a toggle', () => {
    render(<ExpandableError text={short} />)
    expect(screen.getByText(short)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('always keeps the full error text in the DOM, even when collapsed', () => {
    render(<ExpandableError text={long} />)
    // The full 1000-char body is present (collapse is visual only, via CSS).
    expect(screen.getByText(long)).toBeInTheDocument()
  })

  it('shows a "Show more" toggle for long errors and expands on click', async () => {
    render(<ExpandableError text={long} />)
    const toggle = screen.getByRole('button', { name: 'Show more' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
  })
})
