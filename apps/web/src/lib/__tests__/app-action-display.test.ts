import { describe, expect, it } from 'vitest'
import { CATALOGUE, catalogueActions } from '@bidspoke/service-catalogue/schema'
import { appActionDisplay, appActionRealSend, realSendConnectionOf } from '../app-action-display'

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

describe('the words of the tick box before a test that sends for real (#2339, docs/design/app-action-test-send.html)', () => {
  const gmail = { service: 'google', action: 'google.gmail-send-email', actionVersion: 1 }

  it('names what the action sends and the connection it sends from', () => {
    expect(appActionRealSend(gmail, 'Ops mailbox')).toBe('Send for real. This sends a real email from Ops mailbox. It cannot be taken back.')
    expect(appActionRealSend({ service: 'slack', action: 'slack.send-message', actionVersion: 1 }, 'Ops bot'))
      .toBe('Send for real. This posts a real Slack message from Ops bot. It cannot be taken back.')
  })

  it('says this step\'s connection while its name is not known, never another name', () => {
    expect(appActionRealSend(gmail, null)).toBe('Send for real. This sends a real email from this step\'s connection. It cannot be taken back.')
  })

  it('asks nothing for a read, or for an action version the catalogue does not have, which sends nothing', () => {
    expect(appActionRealSend({ service: 'google', action: 'google.drive-list-files', actionVersion: 1 }, 'Ops drive')).toBeNull()
    expect(appActionRealSend({ ...gmail, actionVersion: 99 }, 'Ops mailbox')).toBeNull()
    expect(appActionRealSend({}, 'Ops mailbox')).toBeNull()
  })

  it('every action that changes something has words for it, read from the catalogue', () => {
    for (const action of catalogueActions(CATALOGUE).filter((a) => a.sideEffect)) {
      const words = appActionRealSend({ service: action.key.split('.')[0], action: action.key, actionVersion: action.version }, 'X')
      expect(words, action.key).toMatch(/^Send for real\. This [a-z].* from X\. It cannot be taken back\.$/)
    }
  })
})

describe('realSendConnectionOf', () => {
  it('names the connection only of an App Action step whose action sends for real', () => {
    const gmail = { service: 'google', action: 'google.gmail-send-email', actionVersion: 1, connection: 'c1' }
    expect(realSendConnectionOf('app_action', gmail)).toBe('c1')
    expect(realSendConnectionOf('app_action', { ...gmail, action: 'google.drive-list-files' })).toBeNull()
    expect(realSendConnectionOf('salesforce', gmail)).toBeNull()
    expect(realSendConnectionOf('app_action', { ...gmail, connection: undefined })).toBeNull()
  })
})
