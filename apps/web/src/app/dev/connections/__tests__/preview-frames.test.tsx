/**
 * The development preview's frames drawn by their events (#2338): the states
 * the settled design never drew (build PRs 9 and 10), and the settled add,
 * saved, Reconnect, Replace and Remove frames (build PR 10). Each, reached by
 * its id alone, draws its state through the real component and reducer, holds
 * a counting state still, and fetches nothing.
 */
import { render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionsScreen, type ConnectionsSource } from '@/components/connections/ConnectionsScreen'
import { PREVIEW_NOW, previewScript, previewServices, SCRIPTED_FRAMES } from '../connections-preview-source'

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
  // Build PR 10: the settled frames of the form and the dialogs, drawn by their events.
  'add-choose': ['Add a connection', 'A user and account, signed in by key pair'],
  'add-salesforce': ['Add a connection', 'Client secret'],
  'add-saving': ['Checking the login with Salesforce, 6 s'],
  'add-failed': ['Salesforce refused the client secret. Nothing was saved. Check the secret and save again.'],
  'add-salesforce-new-org': ['Client id'],
  'add-google-company': ['A company mailbox or drive', 'From the company list'],
  'add-google-own': ['Sign in with Google'],
  'saved': ['Achieve Salesforce 2', 'just now'],
  'reconnect': ['Reconnect Achieve Salesforce', 'New client secret'],
  'replace': ['Replace Pennie Salesforce', 'Each ticked workflow gets a new version with TPL2 Salesforce.', 'Replace in 6 workflows'],
  'remove': ['Remove Achieve Salesforce 2?', 'Its login is deleted from Bidspoke and cannot be brought back.'],
  // Build PR 10: the states the settled design never drew.
  'add-stalled': ['The login check with Salesforce did not answer within 120 seconds, so Bidspoke cannot tell whether the connection was saved.'],
  'add-failed-no-cap': ['Bidspoke has no approved cap for the Salesforce org lendco.my.salesforce.com.'],
  'add-snowflake': ['Private key', 'Warehouse', 'Schema'],
  'add-leave-ask': ['The new connection is not saved', 'Leaving discards what is typed into its form.'],
  'add-saving-leave-ask': ['The login is still being checked'],
  'reconnect-saving': ['Checking the login with Salesforce, 4 s'],
  'reconnect-failed': ['Salesforce refused the client secret. Nothing was saved. Check the secret and save again.'],
  'reconnect-stalled': ['so Bidspoke cannot tell whether the new login was saved.'],
  'reconnect-snowflake': ['Reconnect Reporting warehouse', 'New private key'],
  'remove-removing': ['Removing Achieve Salesforce 2, 4 s'],
  'remove-refused-in-use': ['Daily Salesforce cleanup uses this connection, so it cannot be removed.'],
  'remove-ops-not-told': ['The workflows server could not be told straight away'],
}

function quiet(): ConnectionsSource {
  const never = vi.fn(() => new Promise<never>(() => {}))
  return { list: never, history: never, googleSubjects: never, addGoogleSubject: never, removeGoogleSubject: never, create: never, reconnect: never, remove: never }
}

describe('the preview frames for states the design never drew', () => {
  it.each(SCRIPTED_FRAMES)('%s draws its state with no call made', async (frame) => {
    const script = previewScript(frame)!
    const source = quiet()
    const { unmount } = render(
      <ConnectionsScreen source={source} services={previewServices()} clock={{ now: () => PREVIEW_NOW, every: () => () => {} }} orgNames={script.orgNames} initialEvents={script.events} noInitialLoad initialFocus={script.focus} initialLeaveTo={script.leaveTo} />,
    )
    // The whole document: a dialog is drawn at the end of the body, outside the page.
    const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')
    for (const s of SHOWS[frame]) await waitFor(() => expect(text(), frame).toContain(s))
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
