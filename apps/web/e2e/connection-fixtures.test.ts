/**
 * The Connections page fixtures the accessibility job is answered from (#2611).
 *
 * They are committed, so they carry no real identity (L155), and they must reach
 * the surfaces the spec scans: every status the page draws, a problem notice, a
 * connection Remove is offered for, a person's own Google account, and History
 * for the connections whose tab the spec opens. The Worker's
 * connections-fixtures-contract.test.ts holds each file to its route's answer.
 */
import { describe, expect, it } from 'vitest'
import { answerConnectionsFor, loadConnectionFixtures } from './connection-fixtures'
import { listGroups, viewOf } from '../src/components/connections/connection-model'

const fx = loadConnectionFixtures()
const W = 'https://worker.example'
const idOf = (name: string) => fx.list.connections.find((c) => c.name === name)!.id

/** Every string in a JSON value. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn)
  return []
}

describe('the connections fixtures', () => {
  it('draw every group the page shows: problems first, then each service, with the Google list entry', () => {
    const groups = listGroups(fx.list.connections.map(viewOf))
    expect(groups[0]).toMatchObject({ heading: 'Needs attention', attention: true })
    expect(groups[0].items.map((c) => c.name).sort()).toEqual(['Achieve Salesforce', 'Reporting warehouse', 'Reports drive'])
    expect(groups.find((g) => g.googleEntry)?.heading).toBe('Google')
    expect(groups.length).toBeGreaterThanOrEqual(8)
  })

  it('hold the connections each scan opens: a removable one, a person bound one, the alerts login and one with no status', () => {
    const views = fx.list.connections.map(viewOf)
    const byName = (name: string) => views.find((c) => c.name === name)!
    expect(byName('Lead notes')).toMatchObject({ workflows: [], alertLogin: false })
    expect(byName("Editor A's calendar").ownAccount).toBe(true)
    expect(byName('Bidspoke Alerts').alertLogin).toBe(true)
    expect(byName('Partner status API').status).toBeNull()
    expect(fx.remove.connection.id).toBe(idOf('Lead notes'))
    expect(fx.remove.ops.told).toBe(false)
  })

  it('carry no real identity: every address is an example one', () => {
    const all = stringsIn([fx.list, fx.history, fx.googleSubjects, fx.slackAlerts, fx.remove])
    const addresses = all.filter((s) => /@/.test(s))
    expect(addresses.length).toBeGreaterThan(0)
    expect(addresses.filter((s) => !/@[a-z0-9.-]*example(\.com)?$/i.test(s))).toEqual([])
    expect(all.filter((s) => /trypennie/i.test(s))).toEqual([])
  })

  it('give History only for connections the list holds', () => {
    const ids = new Set(fx.list.connections.map((c) => c.id))
    for (const id of Object.keys(fx.history)) expect(ids.has(id), id).toBe(true)
  })
})

describe('answerConnectionsFor', () => {
  it('answers each read the page makes', () => {
    expect(answerConnectionsFor('GET', `${W}/api/connections`, fx)).toEqual({ status: 200, body: fx.list })
    expect(answerConnectionsFor('GET', `${W}/api/connections/google/subjects`, fx)).toEqual({ status: 200, body: fx.googleSubjects })
    expect(answerConnectionsFor('GET', `${W}/api/integrations/slack`, fx)).toEqual({ status: 200, body: fx.slackAlerts })
    const achieve = idOf('Achieve Salesforce')
    expect(answerConnectionsFor('GET', `${W}/api/connections/${achieve}/history`, fx)).toEqual({ status: 200, body: fx.history[achieve] })
  })

  it('answers no History it does not hold, and no inherited name', () => {
    expect(answerConnectionsFor('GET', `${W}/api/connections/${idOf('Lead notes')}/history`, fx)).toBeNull()
    expect(answerConnectionsFor('GET', `${W}/api/connections/constructor/history`, fx)).toBeNull()
    expect(answerConnectionsFor('GET', `${W}/api/connections/__proto__/history`, fx)).toBeNull()
  })

  it('answers a Remove of the one connection the scan removes, and no other change', () => {
    expect(answerConnectionsFor('DELETE', `${W}/api/connections/${idOf('Lead notes')}`, fx)).toEqual({ status: 200, body: fx.remove })
    expect(answerConnectionsFor('DELETE', `${W}/api/connections/${idOf('Pennie Salesforce')}`, fx)).toBeNull()
    expect(answerConnectionsFor('POST', `${W}/api/connections`, fx)).toBeNull()
    expect(answerConnectionsFor('POST', `${W}/api/connections/${idOf('Achieve Salesforce')}/reconnect`, fx)).toBeNull()
    expect(answerConnectionsFor('PATCH', `${W}/api/integrations/slack/settings`, fx)).toBeNull()
  })

  it('answers no route it was not written for', () => {
    expect(answerConnectionsFor('GET', `${W}/api/partners`, fx)).toBeNull()
    expect(answerConnectionsFor('GET', `${W}/api/integrations/slack/channels?q=ops`, fx)).toBeNull()
  })
})
