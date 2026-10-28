import { describe, expect, it } from 'vitest'
import { CATALOGUE, STEP_OUTPUT_MAX_BYTES, catalogueActions } from '@bidspoke/service-catalogue/schema'
import { TOO_BIG_TO_KEEP_SENTENCE, appActionDisplay, appActionRealSend, kilobytes, realSendConnectionOf } from '../app-action-display'

/**
 * What an App Action step's card says (#2339, docs/design/app-action-node-card.html):
 * the service in its header, as a person knows it (Google Drive, not Google), and
 * the pinned action version's name in a chip, read from the catalogue.
 */
describe('appActionDisplay', () => {
  it('names a Google step by the product its action runs in, and its action without the product prefix', () => {
    expect(appActionDisplay({ service: 'google', action: 'google.drive-list-files', actionVersion: 1 })).toEqual({ service: 'Google Drive', action: 'List files', mark: 'google.drive' })
    expect(appActionDisplay({ service: 'google', action: 'google.sheets-add-row', actionVersion: 1 })).toMatchObject({ service: 'Google Sheets', action: 'Add a row', mark: 'google.sheets' })
    expect(appActionDisplay({ service: 'google', action: 'google.gmail-send-email', actionVersion: 1 })).toMatchObject({ service: 'Gmail', action: 'Send an email', mark: 'google.gmail' })
    expect(appActionDisplay({ service: 'google', action: 'google.calendar-create-event', actionVersion: 1 })).toMatchObject({ service: 'Google Calendar', action: 'Create an event', mark: 'google.calendar' })
  })

  it('names any other service by its catalogue name and its own mark, and a markless one (Slack) with none', () => {
    expect(appActionDisplay({ service: 'slack', action: 'slack.send-message', actionVersion: 1 })).toEqual({ service: 'Slack', action: 'Send message', mark: null })
    expect(appActionDisplay({ service: 'snowflake', action: 'snowflake.execute-sql-query', actionVersion: 1 })).toMatchObject({ service: 'Snowflake', mark: 'snowflake' })
    expect(appActionDisplay({ service: 'anthropic' })).toMatchObject({ service: 'Anthropic', mark: 'anthropic' })
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

/**
 * The size an earlier step's too big answer is named by (#2882, decision D2 of
 * docs/design/insert-too-big-answer.html): the ops Worker's own kept limit,
 * STEP_OUTPUT_MAX_BYTES, shared through the catalogue's schema entry, written
 * in KB of 1,000 bytes. app-action-too-big-limit.test.ts proves the sentence
 * moves when the limit does.
 */
describe('the too big to keep sentence', () => {
  it('writes a size in KB of 1,000 bytes, never claiming more than the bytes hold', () => {
    expect(kilobytes(160_000)).toBe('160 KB')
    expect(kilobytes(1_234_000)).toBe('1,234 KB')
    expect(kilobytes(160_999)).toBe('160 KB')
  })

  it('names the limit the ops Worker keeps answers by', () => {
    expect(STEP_OUTPUT_MAX_BYTES).toBe(160_000)
    expect(TOO_BIG_TO_KEEP_SENTENCE).toBe(`Its last test answered more than ${kilobytes(STEP_OUTPUT_MAX_BYTES)}, too much to keep, so it has no values.`)
    expect(TOO_BIG_TO_KEEP_SENTENCE).toBe('Its last test answered more than 160 KB, too much to keep, so it has no values.')
  })
})
