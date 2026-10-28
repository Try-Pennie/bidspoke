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
import { loadedOf } from '../src/components/connections/ConnectionsScreen'

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

  it('hold a Replace of Pennie Salesforce with TPL2 Salesforce that moved all but one, so the dialog stays open with its red line', () => {
    expect(fx.replace.connection.id).toBe(idOf('Pennie Salesforce'))
    expect(fx.replace.with).toEqual({ id: idOf('TPL2 Salesforce'), name: 'TPL2 Salesforce' })
    expect(fx.replace.outcome).toBe('incomplete')
    const pennie = fx.list.connections.find((c) => c.name === 'Pennie Salesforce')!
    expect(fx.replace.workflows.map((w) => w.id)).toEqual(pennie.workflows!.map((w) => w.id))
    expect(fx.replace.workflows.filter((w) => w.outcome !== 'replaced').map((w) => [w.name, w.outcome])).toEqual([['Lead Completed sync', 'changed']])
  })

  it('carry no real identity: every address is an example one', () => {
    const all = stringsIn([fx.list, fx.listStale, fx.history, fx.googleSubjects, fx.slackAlerts, fx.remove, fx.replace])
    const addresses = all.filter((s) => /@/.test(s))
    expect(addresses.length).toBeGreaterThan(0)
    expect(addresses.filter((s) => !/@[a-z0-9.-]*example(\.com)?$/i.test(s))).toEqual([])
    expect(all.filter((s) => /trypennie/i.test(s))).toEqual([])
  })

  it('hold an out of date list: the same connections and statuses, drawn under the strip with the time they are from (#2864)', () => {
    const stale = loadedOf(fx.listStale)
    expect(stale.statuses).toEqual({ stale: true, asOf: fx.list.statuses.as_of })
    expect(stale.statuses.asOf).not.toBeNull()
    expect(loadedOf(fx.list).statuses.stale).toBe(false)
    expect(stale.connections.map((c) => [c.name, c.status])).toEqual(loadedOf(fx.list).connections.map((c) => [c.name, c.status]))
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

  it('answers the list out of date only when asked to', () => {
    expect(answerConnectionsFor('GET', `${W}/api/connections`, fx, { staleStatuses: true })).toEqual({ status: 200, body: fx.listStale })
    expect(answerConnectionsFor('GET', `${W}/api/connections`, fx, { staleStatuses: false })).toEqual({ status: 200, body: fx.list })
    // Every other read is answered the same either way.
    expect(answerConnectionsFor('GET', `${W}/api/connections/google/subjects`, fx, { staleStatuses: true })).toEqual({ status: 200, body: fx.googleSubjects })
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

  it('answers the one Replace the scan makes, and no other', () => {
    const pennie = idOf('Pennie Salesforce')
    expect(answerConnectionsFor('POST', `${W}/api/connections/${pennie}/replace`, fx)).toEqual({ status: 200, body: fx.replace })
    expect(answerConnectionsFor('POST', `${W}/api/connections/${idOf('Achieve Salesforce')}/replace`, fx)).toBeNull()
    expect(answerConnectionsFor('GET', `${W}/api/connections/${pennie}/replace`, fx)).toBeNull()
  })

  it('answers no route it was not written for', () => {
    expect(answerConnectionsFor('GET', `${W}/api/partners`, fx)).toBeNull()
    expect(answerConnectionsFor('GET', `${W}/api/integrations/slack/channels?q=ops`, fx)).toBeNull()
  })
})
