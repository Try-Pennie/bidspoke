/**
 * The Connections page's reading of the list (#2338, build PR 9): the groups,
 * the problem notice's sentences, the times, the history and the Google list's
 * words. The design's own sentences (docs/design/connections-page.fixture.json)
 * are the expected values where the design draws one.
 */
import { describe, expect, it } from 'vitest'
import { CONNECTION_STATUS_WORDS } from '@bidspoke/service-catalogue/schema'
import type { ConnectionListRow } from '@/lib/api'
import fixture from '../../../../../../docs/design/connections-page.fixture.json'
import {
  agoText, delegationAdded, delegationKindOf, delegationShown, etMoment, historyWhat, listGroups, problemNotice, statusWord, viewOf, type ConnectionView,
} from '../connection-model'

const NOW = Date.parse('2026-10-20T16:00:00Z') // 12:00 PM ET

const conn = (over: Partial<ConnectionView>): ConnectionView => ({
  id: over.name ?? 'c', name: 'c', service: 'salesforce', serviceName: 'Salesforce', actsAs: null, status: 'ok', org: null,
  workflows: [], lastCheckedAt: null, problemSince: null, problemCause: null, alertLogin: false, ...over,
})

describe('listGroups (R3, D3)', () => {
  it('puts every connection with a problem in Needs attention first, then the rest by service, both alphabetical', () => {
    const groups = listGroups([
      conn({ name: 'TPL2 Salesforce' }), conn({ name: 'Pennie Salesforce' }),
      conn({ name: 'Achieve Salesforce', status: 'reauth' }), conn({ name: 'Lead notes', service: 'anthropic', serviceName: 'Anthropic', status: 'failing' }),
      conn({ name: 'Reporting warehouse', service: 'snowflake', serviceName: 'Snowflake' }),
    ])
    expect(groups.map((g) => [g.heading, g.items.map((i) => i.name)])).toEqual([
      ['Needs attention', ['Lead notes', 'Achieve Salesforce']],
      ['Google', []],
      ['Salesforce', ['Pennie Salesforce', 'TPL2 Salesforce']],
      ['Snowflake', ['Reporting warehouse']],
    ])
  })

  it('always has the Google section, opening with the company list entry, even with no Google connection', () => {
    const google = listGroups([conn({ name: 'Pennie Salesforce' })]).find((g) => g.heading === 'Google')
    expect(google).toMatchObject({ googleEntry: true, items: [] })
  })

  it('reads a connection with no known status as no problem, under its service', () => {
    expect(listGroups([conn({ name: 'x', status: null })]).map((g) => g.heading)).toEqual(['Google', 'Salesforce'])
  })

  it('draws the design fixture as the settled design groups it', () => {
    const views = fixture.connections.map((c) => conn({ name: c.name, serviceName: c.service, status: c.status as ConnectionView['status'] }))
    const groups = listGroups(views)
    expect(groups[0]).toMatchObject({ heading: 'Needs attention' })
    expect(groups[0].items.map((i) => i.name)).toEqual(['Lead notes', 'Achieve Salesforce'])
    expect(groups.slice(1).map((g) => g.heading)).toEqual(['Google', 'HTTP', 'OpenAI', 'Salesforce', 'Slack', 'Snowflake', 'Supabase'])
  })
})

describe('the status words come from the catalogue', () => {
  it('matches the settled vocabulary', () => {
    expect(fixture.statusVocabulary).toEqual(CONNECTION_STATUS_WORDS)
    expect(statusWord('reauth')).toBe('Needs reconnecting')
    expect(statusWord(null)).toBeNull()
  })
})

describe('problemNotice (R7, D7)', () => {
  const achieve = conn({
    name: 'Achieve Salesforce', status: 'reauth', org: 'achieve.my.salesforce.com',
    problemSince: '2026-10-20T13:52:00Z', problemCause: 'login_refused: invalid_client',
    workflows: [{ id: 'w1', name: 'Achieve report import', deleted: false }],
  })
  const design = fixture.connections.find((c) => c.name === 'Achieve Salesforce')!

  it("reads the design's notice for Achieve Salesforce, word for word", () => {
    expect(problemNotice(achieve, NOW, { 'achieve.my.salesforce.com': 'Achieve' })).toEqual({
      cause: `Since ${design.since}, ${design.cause}`,
      effect: design.effect,
      fix: design.fix,
    })
  })

  it('names an org Bidspoke has no name for by its address, and a day that is not today', () => {
    const n = problemNotice({ ...achieve, problemSince: '2026-10-18T13:52:00Z' }, NOW)!
    expect(n.cause).toBe('Since Oct 18, 9:52 AM ET, Salesforce has refused its client secret.')
    expect(n.fix).toBe('Reconnect with a new client secret from the Salesforce admin of achieve.my.salesforce.com.')
  })

  it('says what a failing check does to several workflows, and leaves the effect out when none uses it', () => {
    const failing = conn({ name: 'Lead notes', service: 'anthropic', serviceName: 'Anthropic', status: 'failing', problemSince: '2026-10-20T15:59:00Z',
      workflows: [{ id: 'a', name: 'A', deleted: false }, { id: 'b', name: 'B', deleted: false }, { id: 'old', name: 'Old', deleted: true }] })
    expect(problemNotice(failing, NOW)).toEqual({
      cause: "Since 11:59 AM ET, Bidspoke's checks of this login with Anthropic have failed.",
      effect: 'A and B may stop at their Anthropic steps.',
      fix: 'Reconnect to check the login again.',
    })
    expect(problemNotice({ ...failing, workflows: [] }, NOW)!.effect).toBeNull()
  })

  it('words the Slack alert login by its token, with no time when Slack is what measured it', () => {
    const alerts = conn({ name: 'Bidspoke Alerts', service: 'slack', serviceName: 'Slack', status: 'reauth', alertLogin: true })
    expect(problemNotice(alerts, NOW)).toEqual({ cause: 'Slack has refused its token.', effect: null, fix: 'Save a new token for it from the Slack app.' })
  })

  it('gives no notice to a working connection', () => {
    expect(problemNotice(conn({}), NOW)).toBeNull()
  })
})

describe('times, in Eastern', () => {
  it('says how long ago a check answered', () => {
    expect(agoText('2026-10-20T15:59:40Z', NOW)).toBe('just now')
    expect(agoText('2026-10-20T15:56:00Z', NOW)).toBe('4 min ago')
    expect(agoText('2026-10-20T14:00:00Z', NOW)).toBe('2 hours ago')
    expect(agoText('2026-10-20T15:00:00Z', NOW)).toBe('1 hour ago')
    expect(agoText('2026-10-18T15:00:00Z', NOW)).toBe('Oct 18')
  })

  it('names a moment today by its clock, and another day by its date too', () => {
    expect(etMoment('2026-10-20T15:52:00Z', NOW)).toBe('11:52 AM ET')
    expect(etMoment('2026-10-19T15:52:00Z', NOW)).toBe('Oct 19, 11:52 AM ET')
  })
})

describe('viewOf', () => {
  const row = (over: Partial<ConnectionListRow>): ConnectionListRow => ({
    id: 'c1', name: 'Achieve Salesforce', service: 'salesforce', service_name: 'Salesforce', alert_login: false, acts_as: 'x', person_bound: false, owner: null, target: null,
    status: 'reauth', status_word: 'Needs reconnecting', used_by: 1, workflows: [{ id: 'w', name: 'W', deleted: false }], org: 'achieve.my.salesforce.com',
    health: { ops_status: 'needs_reauth', last_check_ok_at: '2026-10-20T13:00:00Z', last_check_failed_at: '2026-10-20T14:00:00Z', last_check_cause: 'timeout', needs_reauth_at: '2026-10-20T13:52:00Z', needs_reauth_cause: 'login_refused: invalid_client' },
    created_at: '', updated_at: '', ...over,
  })

  it('reads the latest check, and the problem from the field its status keys on', () => {
    expect(viewOf(row({}))).toMatchObject({ lastCheckedAt: '2026-10-20T14:00:00Z', problemSince: '2026-10-20T13:52:00Z', problemCause: 'login_refused: invalid_client', org: 'achieve.my.salesforce.com' })
    expect(viewOf(row({ status: 'failing' }))).toMatchObject({ problemSince: '2026-10-20T14:00:00Z', problemCause: 'timeout' })
    expect(viewOf(row({ status: 'ok' }))).toMatchObject({ problemSince: null })
  })

  it('reads a Worker answer from before build PR 9 without its new fields', () => {
    const old = row({}) as Partial<ConnectionListRow>
    delete old.service_name; delete old.workflows; delete old.org; delete old.alert_login
    expect(viewOf(old as ConnectionListRow)).toMatchObject({ serviceName: 'salesforce', workflows: [], org: null, alertLogin: false })
  })
})

describe('history and the Google list words', () => {
  it('says what each history entry did', () => {
    const e = (over: object) => ({ id: 'a', action: 'UPDATE', at: '', by: null, credential_changed: false, changes: {}, ...over })
    expect(historyWhat(e({ action: 'INSERT' }), 'client secret')).toBe('Added')
    expect(historyWhat(e({ credential_changed: true }), 'client secret')).toBe('Reconnected with a new client secret')
    expect(historyWhat(e({ action: 'connection_rechecked' }), 'client secret')).toBe('Login checked again')
    expect(historyWhat(e({}), 'client secret')).toBe('Changed')
  })

  it("shows a drive by its name, says who added each entry and when, and reads an address as a mailbox", () => {
    const drive = { kind: 'drive' as const, subject: '0ABCdefGHIjklMNOpq', display_name: 'Partner reports', added_by: 'Dan Wright', added_at: '2026-10-19T14:00:00Z' }
    expect(delegationShown(drive)).toBe('Partner reports')
    expect(delegationShown({ ...drive, display_name: null })).toBe('0ABCdefGHIjklMNOpq')
    expect(delegationAdded(drive)).toBe('Added by Dan Wright, Oct 19')
    expect(delegationKindOf('ops@trypennie.com')).toBe('mailbox')
    expect(delegationKindOf('0ABCdefGHIjklMNOpq')).toBe('drive')
  })
})
