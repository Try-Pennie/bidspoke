/**
 * The development preview's frames for the states the settled design never
 * drew (#2338, build PR 9): each, reached by its id alone, draws its state
 * through the real component and reducer, holds a counting state at 4 s, and
 * fetches nothing.
 */
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionsScreen, type ConnectionsSource } from '@/components/connections/ConnectionsScreen'
import { PREVIEW_NOW, previewScript, SCRIPTED_FRAMES } from '../connections-preview-source'

vi.mock('next/link', () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }))

/** What each frame must show, read from the rendered page's text. */
const SHOWS: Record<(typeof SCRIPTED_FRAMES)[number], string[]> = {
  'loading': ['Loading, 4 s'],
  'stale-retrying': ['Statuses are as of 11:52 AM ET.', 'Trying again, 4 s'],
  'stale-retry-failed': ["Trying again did not work: Bidspoke's server did not answer."],
  'stale-no-earlier-time': ['Login checks are not answering, and no earlier statuses are kept.'],
  'not-loaded-refused': ['The connections could not be read: the use counts read failed.'],
  'google-adding': ['Adding partners@trypennie.com, 4 s'],
  'google-add-refused': ['ops@trypennie is not one mailbox address or one shared drive id.'],
  'google-removing': ['Removing ops@trypennie.com, 4 s'],
  'google-remove-refused': ['Ops mailbox acts as ops@trypennie.com, so it cannot be taken off the list.'],
  'google-bad-address': ['That is not a Google Drive shared drive address.'],
  'google-add-drive': ['Google mailboxes and drives'],
  'notice-earlier-day': ['Since Oct 18, 9:52 AM ET, Salesforce has refused its client secret.'],
  'notice-many-workflows': ['The 6 workflows using it stop at their Salesforce steps.'],
  'notice-org-by-address': ['Reconnect with a new client secret from the Salesforce admin of achieve.my.salesforce.com.'],
  'used-by-tab': ['Achieve report import'],
  'history-tab': ['Reconnected with a new client secret'],
  'alert-login': ['Its token and the alerts it posts are set on the'],
}

function quiet(): ConnectionsSource {
  const never = vi.fn(() => new Promise<never>(() => {}))
  return { list: never, history: never, googleSubjects: never, addGoogleSubject: never, removeGoogleSubject: never }
}

describe('the preview frames for states the design never drew', () => {
  it.each(SCRIPTED_FRAMES)('%s draws its state with no call made', (frame) => {
    const script = previewScript(frame)!
    const source = quiet()
    const { container, unmount } = render(
      <ConnectionsScreen source={source} clock={{ now: () => PREVIEW_NOW, every: () => () => {} }} orgNames={script.orgNames} initialEvents={script.events} noInitialLoad />,
    )
    const text = (container.textContent ?? '').replace(/\s+/g, ' ')
    for (const s of SHOWS[frame]) expect(text, frame).toContain(s)
    for (const call of Object.values(source)) expect(call).not.toHaveBeenCalled()
    unmount()
  })

  it('draws the drive form in the add drive frame: the address on its own line, the name with Add after it', () => {
    const script = previewScript('google-add-drive')!
    const { container } = render(<ConnectionsScreen source={quiet()} clock={{ now: () => PREVIEW_NOW, every: () => () => {} }} orgNames={script.orgNames} initialEvents={script.events} noInitialLoad />)
    const lines = [...container.querySelectorAll('.ga-add-line')]
    expect(lines.map((l) => [...l.querySelectorAll('input')].map((i) => i.placeholder))).toEqual([['Shared drive address, from Google Drive'], ['Drive name, shown on this list']])
    expect(lines[1].querySelector('button')?.textContent).toBe('Add')
  })

  it('answers no script for a settled frame, which loads through the page itself', () => {
    expect(previewScript('healthy')).toBeNull()
    expect(previewScript(undefined)).toBeNull()
  })
})
