/**
 * The step form's Connection field (#2338 build PR 11, R8, D8): what it offers
 * and every line it draws under itself, as pure functions of the list.
 */
import { describe, expect, it } from 'vitest'
import { CONNECTION_STATUS_WORDS } from '@bidspoke/service-catalogue/schema'
import type { ConnectionView } from '../connection-model'
import { connectionFieldLines, connectionOptions, connectionsPageHref, connectionsFor, emptyLine, CONNECTIONS_PAGE } from '../connection-field-model'

function view(over: Partial<ConnectionView>): ConnectionView {
  return {
    id: 'c-pennie', name: 'Pennie Salesforce', service: 'salesforce', serviceName: 'Salesforce', actsAs: 'integration@trypennie.com',
    status: 'ok', org: null, target: null, workflows: [], lastCheckedAt: null, problemSince: null, problemCause: null, alertLogin: false,
    ...over,
  }
}

const PENNIE = view({})
const ACHIEVE = view({ id: 'c-achieve', name: 'Achieve Salesforce', actsAs: 'pennie.api@achieve.example', status: 'reauth' })
const LENDCO = view({ id: 'c-lendco', name: 'Lendco Salesforce', actsAs: 'api@lendco.example', status: 'failing' })
const SNOWFLAKE = view({ id: 'c-snow', name: 'Warehouse', service: 'snowflake', serviceName: 'Snowflake', actsAs: 'BIDSPOKE' })
const ALERTS = view({ id: 'c-slack', name: 'Bidspoke Alerts', service: 'slack', serviceName: 'Slack', alertLogin: true })

describe('the Connection field model', () => {
  it("offers the service's connections only, by name, each with who it acts as as its second line", () => {
    const list = connectionsFor('salesforce', [SNOWFLAKE, PENNIE, ALERTS, LENDCO, ACHIEVE])
    expect(list.map((c) => c.name)).toEqual(['Achieve Salesforce', 'Lendco Salesforce', 'Pennie Salesforce'])
    expect(connectionOptions(list)).toEqual([
      { value: 'c-achieve', label: 'Achieve Salesforce', hint: 'Acts as pennie.api@achieve.example' },
      { value: 'c-lendco', label: 'Lendco Salesforce', hint: 'Acts as api@lendco.example' },
      { value: 'c-pennie', label: 'Pennie Salesforce', hint: 'Acts as integration@trypennie.com' },
    ])
  })

  it('a connection whose identity is not known has no second line, never "Acts as null"', () => {
    expect(connectionOptions([view({ actsAs: null })])[0]).toEqual({ value: 'c-pennie', label: 'Pennie Salesforce' })
  })

  it('a working connection draws nothing under the field beyond who it acts as, which the dropdown draws', () => {
    expect(connectionFieldLines({ kind: 'ready', connections: [PENNIE] }, 'c-pennie', 'Salesforce')).toEqual([])
  })

  it('a connection with an unknown status says nothing about status', () => {
    expect(connectionFieldLines({ kind: 'ready', connections: [view({ status: null })] }, 'c-pennie', 'Salesforce')).toEqual([])
  })

  it("a connection with a problem adds one line: the catalogue's status word, then where it is fixed, linking to that connection", () => {
    expect(connectionFieldLines({ kind: 'ready', connections: [ACHIEVE] }, 'c-achieve', 'Salesforce')).toEqual([
      { kind: 'problem', word: CONNECTION_STATUS_WORDS.reauth, page: CONNECTIONS_PAGE, href: '/connections?connection=c-achieve' },
    ])
    expect(connectionFieldLines({ kind: 'ready', connections: [LENDCO] }, 'c-lendco', 'Salesforce')).toEqual([
      { kind: 'problem', word: CONNECTION_STATUS_WORDS.failing, page: CONNECTIONS_PAGE, href: '/connections?connection=c-lendco' },
    ])
  })

  it('nothing chosen draws nothing under the field', () => {
    expect(connectionFieldLines({ kind: 'ready', connections: [PENNIE] }, null, 'Salesforce')).toEqual([])
  })

  it('a chosen connection the list no longer holds says so in red, never showing its id', () => {
    const lines = connectionFieldLines({ kind: 'ready', connections: [PENNIE] }, 'c-gone', 'Salesforce')
    expect(lines).toEqual([{ kind: 'gone', sentence: 'The connection this step used no longer exists. Choose another.' }])
    expect(JSON.stringify(lines)).not.toContain('c-gone')
  })

  it('no connection of the service yet says where one is added, whether or not one was chosen', () => {
    const empty = emptyLine('Salesforce')
    expect(empty).toEqual({ kind: 'empty', before: 'No Salesforce connection yet. Add one on the ', page: CONNECTIONS_PAGE, after: '.', href: '/connections' })
    expect(connectionFieldLines({ kind: 'ready', connections: [] }, null, 'Salesforce')).toEqual([empty])
    expect(connectionFieldLines({ kind: 'ready', connections: [] }, 'c-gone', 'Salesforce')).toEqual([empty])
  })

  it('while the list loads it says so with the seconds counted, and a failed load says why with Try again', () => {
    expect(connectionFieldLines({ kind: 'loading', seconds: 6 }, 'c-pennie', 'Salesforce')).toEqual([{ kind: 'loading', label: 'Loading the connections', seconds: 6 }])
    expect(connectionFieldLines({ kind: 'failed', message: "The connections could not be loaded: Bidspoke's server did not answer." }, 'c-pennie', 'Salesforce')).toEqual([
      { kind: 'failed', sentence: "The connections could not be loaded: Bidspoke's server did not answer." },
    ])
  })

  it('links to the Connections page, opening the connection when there is one', () => {
    expect(connectionsPageHref()).toBe('/connections')
    expect(connectionsPageHref('a b')).toBe('/connections?connection=a%20b')
  })
})
