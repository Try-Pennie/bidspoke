/**
 * The partners page live status and section notes (#2135). Three states told
 * apart at a glance (the time taking action rule): Live; paused with the
 * seconds since it dropped; failed with the reason and Retry. Never a bare
 * spinner.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { LiveNotesContext, LivePageNotes, LiveSectionNote, LiveStatusLine } from '../live/PartnerLive'

/** A clock stopped at one moment, whose timers never run. */
const at = (now: number) => ({ now: () => now, setTimeout: () => () => {} })

describe('LiveStatusLine (#2135)', () => {
  it('says Live', () => {
    render(<LiveStatusLine status={{ kind: 'live', since: 0 }} clock={at(5_000)} onRetry={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toBe('Live')
  })

  it('says paused and counts the seconds since it dropped', () => {
    render(<LiveStatusLine status={{ kind: 'reconnecting', since: 10_000, reason: 'CHANNEL_ERROR' }} clock={at(22_400)} onRetry={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toBe('Live updates paused. Reconnecting, 12 s')
  })

  it('says it is connecting, with the seconds, before the first join answers', () => {
    render(<LiveStatusLine status={{ kind: 'connecting', since: 0 }} clock={at(3_000)} onRetry={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toBe('Connecting live updates, 3 s')
  })

  it('says failed with the reason, and Retry joins again', () => {
    const onRetry = vi.fn()
    render(<LiveStatusLine status={{ kind: 'failed', reason: 'You are signed out.' }} clock={at(0)} onRetry={onRetry} />)
    expect(screen.getByRole('alert').textContent).toContain('Live updates failed: You are signed out.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('shows nothing when the page has no live channel', () => {
    const { container } = render(<LiveStatusLine status={null} clock={at(0)} onRetry={vi.fn()} />)
    expect(container.textContent).toBe('')
  })
})

describe('LiveSectionNote (#2135)', () => {
  const notes = [
    { sections: ['Identity'], text: 'Updated by Brian Nelms: Name.' },
    { sections: ['Eligibility', 'Caps'], text: 'Changed directly in the database at 10:34 AM ET.' },
    { sections: [], text: 'Changed directly in the database at 10:35 AM ET.' },
  ]

  it('shows the notes for any of the sections its block holds, each once', () => {
    render(
      <LiveNotesContext.Provider value={notes}>
        <div data-testid="a"><LiveSectionNote sections={['Enabled and ranking', 'Eligibility', 'Caps']} /></div>
        <div data-testid="b"><LiveSectionNote sections={['Identity']} /></div>
        <div data-testid="c"><LiveSectionNote sections={['Bidding limits']} /></div>
        <div data-testid="page"><LivePageNotes /></div>
      </LiveNotesContext.Provider>,
    )
    expect(screen.getByTestId('a').textContent).toBe('Changed directly in the database at 10:34 AM ET.')
    expect(screen.getByTestId('b').textContent).toBe('Updated by Brian Nelms: Name.')
    expect(screen.getByTestId('c').textContent).toBe('')
    expect(screen.getByTestId('page').textContent).toBe('Changed directly in the database at 10:35 AM ET.')
  })
})
