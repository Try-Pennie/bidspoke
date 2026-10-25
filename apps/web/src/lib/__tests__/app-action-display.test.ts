import { describe, expect, it } from 'vitest'
import { appActionDisplay } from '../app-action-display'

/**
 * What an App Action step's card says (#2339, docs/design/app-action-node-card.html):
 * the service in its header, as a person knows it (Google Drive, not Google), and
 * the pinned action version's name in a chip, read from the catalogue.
 */
describe('appActionDisplay', () => {
  it('names a Google step by the product its action runs in, and its action without the product prefix', () => {
    expect(appActionDisplay({ service: 'google', action: 'google.drive-list-files', actionVersion: 1 })).toEqual({ service: 'Google Drive', action: 'List files', mark: 'google-drive' })
    expect(appActionDisplay({ service: 'google', action: 'google.sheets-add-row', actionVersion: 1 })).toMatchObject({ service: 'Google Sheets', action: 'Add a row' })
    expect(appActionDisplay({ service: 'google', action: 'google.gmail-send-email', actionVersion: 1 })).toMatchObject({ service: 'Gmail', action: 'Send an email' })
    expect(appActionDisplay({ service: 'google', action: 'google.calendar-create-event', actionVersion: 1 })).toMatchObject({ service: 'Google Calendar', action: 'Create an event' })
  })

  it('names any other service by its catalogue name, its action by the pinned version\'s name, with no mark of its own', () => {
    expect(appActionDisplay({ service: 'slack', action: 'slack.send-message', actionVersion: 1 })).toEqual({ service: 'Slack', action: 'Send message', mark: null })
  })

  it('shows no chip while no action is chosen, or for a version the catalogue does not have, rather than a newer version\'s name', () => {
    expect(appActionDisplay({})).toEqual({ service: 'App action', action: null, mark: null })
    expect(appActionDisplay({ service: 'slack' })).toEqual({ service: 'Slack', action: null, mark: null })
    expect(appActionDisplay({ service: 'slack', action: 'slack.send-message', actionVersion: 9 })).toEqual({ service: 'Slack', action: null, mark: null })
  })
})
