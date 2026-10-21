/**
 * The Add connection form and the Reconnect dialog, read (#2338, build PR 10):
 * the tiles from the service catalogue, the orgs Bidspoke knows, an org's
 * address read out of whatever was pasted, what a save sends (built by the
 * catalogue's connectionParts), what Reconnect keeps and asks, and the
 * sentences a save or a check says while it runs and when it stalls.
 */
import { describe, expect, it } from 'vitest'
import { CATALOGUE, connectionParts } from '@bidspoke/service-catalogue/schema'
import type { ConnectionView } from '../connection-model'
import {
  catalogueServices, createBodyOf, createdView, draftDirty, EMPTY_ADD_DRAFT, knownOrgs, readOrgAddress, reconnectBodyOf, reconnectFieldsOf,
  saveFailureSentence, stalledSentence, workingLabel, type AddDraft, type FormService,
} from '../add-form-model'

const salesforce = (): FormService => catalogueServices().find((s) => s.key === 'salesforce')!
const snowflake = (): FormService => catalogueServices().find((s) => s.key === 'snowflake')!

const view = (over: Partial<ConnectionView>): ConnectionView => ({
  id: 'c1', name: 'Pennie Salesforce', service: 'salesforce', serviceName: 'Salesforce', actsAs: 'integration@trypennie.com', status: 'ok',
  org: 'trypennie.my.salesforce.com', target: { instance_url: 'https://trypennie.my.salesforce.com', client_id: 'cid' }, workflows: [], lastCheckedAt: null,
  problemSince: null, problemCause: null, alertLogin: false, ...over,
})

const draftFor = (service: string, values: Record<string, string>, name = 'Achieve Salesforce 2'): AddDraft => ({ ...EMPTY_ADD_DRAFT, service, name, values: { [service]: values } })

describe('the tiles (R12, D12)', () => {
  it('are the catalogue\'s services, in its order, each its name and its one line', () => {
    expect(catalogueServices().map((s) => [s.name, s.tile])).toEqual(CATALOGUE.map((s) => [s.name, s.connection.tile]))
    expect(catalogueServices().length).toBeGreaterThanOrEqual(2)
  })
})

describe('the orgs Bidspoke knows (R15, D15)', () => {
  it('are the orgs it holds a name for and every org a Salesforce connection signs in to, by name, each address once, alphabetical', () => {
    const orgs = knownOrgs([view({}), view({ id: 'c2', org: 'achieve.my.salesforce.com' }), view({ id: 'c3', org: 'achieve.my.salesforce.com' }), view({ id: 'c4', service: 'snowflake', org: null })], { 'achieve.my.salesforce.com': 'Achieve', 'tpl2.my.salesforce.com': 'TPL2' })
    expect(orgs).toEqual([
      { value: 'https://achieve.my.salesforce.com', label: 'Achieve', hint: 'achieve.my.salesforce.com' },
      { value: 'https://tpl2.my.salesforce.com', label: 'TPL2', hint: 'tpl2.my.salesforce.com' },
      // No name is held for it, so it is shown by its address, once (L605): no grey line repeating it.
      { value: 'https://trypennie.my.salesforce.com', label: 'trypennie.my.salesforce.com' },
    ])
  })

  it('are none when no Salesforce connection exists and no name is held, so Another org is the only choice', () => {
    expect(knownOrgs([], {})).toEqual([])
  })
})

describe("an org's address, read from what was pasted (the Controls rule, round 29)", () => {
  it.each([
    ['lendco.my.salesforce.com', 'https://lendco.my.salesforce.com'],
    ['  https://Lendco.my.salesforce.com/  ', 'https://lendco.my.salesforce.com'],
    ['https://lendco.my.salesforce.com/lightning/setup/SetupOneHome/home', 'https://lendco.my.salesforce.com'],
    ['http://lendco.my.salesforce.com', 'https://lendco.my.salesforce.com'],
    // A Lightning page's address names the same org under force.com.
    ['https://lendco.lightning.force.com/lightning/page/home', 'https://lendco.my.salesforce.com'],
    ['https://lendco--uat.sandbox.lightning.force.com/one/one.app', 'https://lendco--uat.sandbox.my.salesforce.com'],
  ])('%s is %s', (typed, url) => {
    expect(readOrgAddress(typed)).toEqual({ ok: true, url })
  })

  it.each(['', '   ', 'not an address at all', 'ftp://lendco.my.salesforce.com'])('%j holds no org address', (typed) => {
    expect(readOrgAddress(typed).ok).toBe(false)
  })
})

describe('what a save sends', () => {
  it('is the service, the trimmed name and each field by its key, which the catalogue builds the login and target from', () => {
    const body = createBodyOf(salesforce(), draftFor('salesforce', { instance_url: 'https://achieve.my.salesforce.com', client_id: '3MVG9xk2Q7R1s0p0Lm', client_secret: 'plainsecrets' }, '  Achieve Salesforce 2 '))
    expect(body).toEqual({ service: 'salesforce', name: 'Achieve Salesforce 2', fields: { instance_url: 'https://achieve.my.salesforce.com', client_id: '3MVG9xk2Q7R1s0p0Lm', client_secret: 'plainsecrets' } })
    expect(connectionParts(salesforce().connection, body.fields)).toMatchObject({ ok: true, target: { instance_url: 'https://achieve.my.salesforce.com', client_id: '3MVG9xk2Q7R1s0p0Lm' } })
  })

  it("sends a typed new org as the org's address, read out of what was typed", () => {
    expect(createBodyOf(salesforce(), draftFor('salesforce', { instance_url: 'lendco.lightning.force.com/lightning/page/home', client_id: 'c', client_secret: 's' })).fields.instance_url).toBe('https://lendco.my.salesforce.com')
  })

  it('sends what was typed when it holds no address, so the route names the refusal in its own words', () => {
    expect(createBodyOf(salesforce(), draftFor('salesforce', { instance_url: 'lendco', client_id: 'c', client_secret: 's' })).fields.instance_url).toBe('lendco')
  })

  it("leaves out blank fields and fields of another service, keeping a secret's line breaks", () => {
    const d: AddDraft = { ...draftFor('snowflake', { account: 'ab1', user: 'OPS', private_key: 'line one\nline two\n', warehouse: '  ' }), values: { snowflake: { account: 'ab1', user: 'OPS', private_key: 'line one\nline two\n', warehouse: '  ' }, salesforce: { client_id: 'other' } } }
    expect(createBodyOf(snowflake(), d).fields).toEqual({ account: 'ab1', user: 'OPS', private_key: 'line one\nline two\n' })
  })
})

describe('an unsaved form', () => {
  it('is dirty once anything is typed, and not for a service chosen with nothing typed', () => {
    expect(draftDirty(EMPTY_ADD_DRAFT)).toBe(false)
    expect(draftDirty({ ...EMPTY_ADD_DRAFT, service: 'salesforce' })).toBe(false)
    expect(draftDirty({ ...EMPTY_ADD_DRAFT, service: 'salesforce', name: ' ' })).toBe(false)
    expect(draftDirty({ ...EMPTY_ADD_DRAFT, name: 'Achieve' })).toBe(true)
    expect(draftDirty(draftFor('salesforce', { client_secret: 'x' }, ''))).toBe(true)
  })
})

describe('Reconnect keeps what the connection names and asks for the login anew (R19, D19)', () => {
  it("shows the client id kept, from the connection's target, and asks for a new client secret", () => {
    expect(reconnectFieldsOf(salesforce().connection, { instance_url: 'https://achieve.my.salesforce.com', client_id: '3MVG9xk2Q7R1s0p0Lm' })).toEqual({
      kept: [{ key: 'client_id', label: 'Client id', value: '3MVG9xk2Q7R1s0p0Lm' }],
      asked: [{ key: 'client_secret', label: 'New client secret', input: 'secret' }],
    })
  })

  it('keeps none for a service whose login is all secret, and asks for each login field', () => {
    expect(reconnectFieldsOf(snowflake().connection, { account: 'ab1', user: 'OPS' })).toEqual({ kept: [], asked: [{ key: 'private_key', label: 'New private key', input: 'secret_block' }] })
  })

  it('sends only what was typed anew; nothing typed checks the stored login again', () => {
    expect(reconnectBodyOf({ client_secret: 'plainsecrets' })).toEqual({ fields: { client_secret: 'plainsecrets' } })
    expect(reconnectBodyOf({ client_secret: '   ' })).toEqual({})
    expect(reconnectBodyOf({})).toEqual({})
  })
})

describe('the sentences while a check runs, and when it stalls (R13, R14)', () => {
  it('says what is happening, with the service named', () => {
    expect(workingLabel('Salesforce')).toBe('Checking the login with Salesforce')
  })

  it("says, at the deadline, that whether it was saved is not known and what to do, never that nothing was saved", () => {
    const s = stalledSentence('Salesforce', 75_000, 'saved')
    expect(s).toBe('The login check with Salesforce did not answer within 75 seconds, so Bidspoke cannot tell whether the connection was saved. Reload the page to see before saving again.')
    expect(s).not.toContain('Nothing was saved')
    expect(stalledSentence('Salesforce', 75_000, 'reconnected')).toContain('whether the new login was saved')
    expect(stalledSentence('Salesforce', 30_000, 'removed')).toBe('Bidspoke did not answer within 30 seconds, so it cannot tell whether the connection was removed. Reload the page to see before removing it again.')
  })

  it("shows the route's own sentence for a refusal, and for a call that got no answer says so in plain words", () => {
    const refused = Object.assign(new Error('connection_needs_reauth'), { status: 422, body: { error: 'connection_needs_reauth', message: 'Salesforce refused the client secret. Nothing was saved. Check the secret and save again.' } })
    expect(saveFailureSentence(refused, 'Salesforce', 75_000, 'saved')).toBe('Salesforce refused the client secret. Nothing was saved. Check the secret and save again.')
    // The client's ceiling passed: the save may have landed, so it is the stalled sentence.
    expect(saveFailureSentence(Object.assign(new Error('Timed out'), { timedOut: true, timeoutMs: 75_000 }), 'Salesforce', 75_000, 'saved')).toBe(stalledSentence('Salesforce', 75_000, 'saved'))
    // No answer at all: the request may or may not have reached the server, so it is not known (L11).
    expect(saveFailureSentence(new TypeError('Failed to fetch'), 'Salesforce', 75_000, 'saved')).toBe("Bidspoke's server could not be reached, so whether the connection was saved is not known. Reload the page to see before saving again.")
    expect(saveFailureSentence(Object.assign(new Error('API 500'), { status: 500 }), 'Salesforce', 75_000, 'saved')).toBe("Bidspoke's server failed while answering, so whether the connection was saved is not known. Reload the page to see before saving again.")
    expect(saveFailureSentence(Object.assign(new Error('API 500'), { status: 500 }), 'Salesforce', 30_000, 'removed')).toBe("Bidspoke's server failed while answering, so whether the connection was removed is not known. Reload the page to see before removing it again.")
    // Refused before the route ran (the sign in), so nothing was changed.
    expect(saveFailureSentence(Object.assign(new Error('Not authenticated'), { status: 401 }), 'Salesforce', 75_000, 'saved')).toBe('Your sign in has ended, so nothing was saved. Sign in again in a new tab, then save again.')
    expect(saveFailureSentence(Object.assign(new Error('Not authenticated'), { status: 401 }), 'Salesforce', 30_000, 'removed')).toBe('Your sign in has ended, so nothing was removed. Sign in again in a new tab, then remove it again.')
  })
})

describe('the connection a save made, as the list shows it (R18)', () => {
  it('is working, checked just now, used by nothing, with the org it names and who Salesforce says it acts as', () => {
    const now = Date.parse('2026-10-20T16:41:00Z')
    expect(createdView({ id: 'new1', name: 'Achieve Salesforce 2', service: 'salesforce', acts_as: 'pennie.api@achieve.example', target: { instance_url: 'https://achieve.my.salesforce.com', client_id: 'c' }, created_at: '2026-10-20T16:41:00Z' }, salesforce(), now)).toEqual({
      id: 'new1', name: 'Achieve Salesforce 2', service: 'salesforce', serviceName: 'Salesforce', actsAs: 'pennie.api@achieve.example', status: 'ok',
      org: 'achieve.my.salesforce.com', target: { instance_url: 'https://achieve.my.salesforce.com', client_id: 'c' }, workflows: [],
      lastCheckedAt: '2026-10-20T16:41:00.000Z', problemSince: null, problemCause: null, alertLogin: false,
    })
  })
})
