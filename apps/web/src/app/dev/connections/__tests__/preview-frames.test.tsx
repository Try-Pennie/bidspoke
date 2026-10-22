/**
 * The development preview's frames drawn by their events (#2338): the states
 * the settled design never drew (build PRs 9, 10 and 14), and the settled add,
 * saved, Reconnect, Replace and Remove frames (build PR 10) and the Slack
 * alerts login's (build PR 14). Each, reached by
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
  'alert-login': ['Alerts', 'Posts to', '#bidspoke-alerts', 'Change', 'Volume anomaly alerts', "When a day's runs are far above or below normal.", 'Bid matrix change alerts', 'Reconnect'],
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
  'add-failed-no-cap': ['Bidspoke has no limit set yet on how many Salesforce calls its workflows may make to lendco.my.salesforce.com, so it cannot connect to that org. Nothing was saved. Ask Dan to set a limit for this org, then save again.'],
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
  // Build PR 14: the Slack alerts login's Reconnect and its alert settings.
  'alert-reconnect': ['Reconnect Bidspoke Alerts', 'New bot token'],
  'alert-reconnect-checking': ['Checking the login with Slack, 4 s'],
  'alert-reconnect-refused': ['Slack did not accept this token (invalid_auth). Nothing was saved. Check the token in the Slack app and save again.'],
  'alert-login-refused': ['Slack has refused its token.', 'Reconnect with a new token from the Slack app.'],
  'alert-switch-saving': ['Turning off volume anomaly alerts, 4 s'],
  'alert-switch-saved': ['Turned off. These alerts no longer post.'],
  'alert-switch-failed': ['Volume anomaly alerts may not have been turned off: the server answered with an error (HTTP 503). Reload the page to see whether it is off.'],
  'alert-channel-open': ['Posts to', 'Save', 'Cancel'],
  'alert-channel-chosen': ['Save', 'Cancel'],
  'alert-channel-saving': ['Moving the alerts to #ops-alerts, 4 s'],
  'alert-channel-failed': ['Alerts may not have been moved to #ops-alerts: the server answered with an error (HTTP 503). Reload the page to see where they post.'],
  'alert-channel-saved': ['Alerts now post to #ops-alerts.'],
  'alert-settings-loading': ['Loading the alert settings, 4 s'],
  'alert-settings-failed': ['The alert settings could not be read: the server did not answer within 30 seconds.', 'Try again'],
  'alert-settings-none': ['This organization has no Slack alert connection, so there are no alert settings to show.'],
  'alert-channel-leave-ask': ['The new alert channel is not saved', 'Leaving discards the channel chosen for the alerts.'],
  // #2337: the ops Slack bot, now the catalogue's own service.
  'add-slack': ['A bot in a Slack workspace', 'Workspace ID', 'Bot token'],
  'add-slack-not-a-bot': ['This token acts as a person, not as a bot. Nothing was saved. Use the bot token from the ops Slack app and save again.'],
  'add-slack-workspace-mismatch': ['Slack says this bot is in another workspace than the Workspace ID entered. Nothing was saved. Check the Workspace ID and save again.'],
  'slack-ops-bot': ['Ops alerts bot', 'Bidspoke Ops in Pennie'],
}

function quiet(): ConnectionsSource {
  const never = vi.fn(() => new Promise<never>(() => {}))
  return { list: never, history: never, googleSubjects: never, addGoogleSubject: never, removeGoogleSubject: never, create: never, reconnect: never, remove: never, slackAlerts: never, updateSlackAlerts: never, searchSlackChannels: never }
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
