/**
 * Every refusal the create route can answer has one plain sentence the page
 * shows (#2338, build PR 5; R14, D14), held in one place. So does every refusal
 * the Reconnect, Remove and Google list routes add (build PR 6; R9, R10, R19,
 * R21), in the same module.
 */
import { describe, expect, it } from 'vitest'
import { OPS_CONNECTIONS_REFUSAL_CODES } from '../ops-connections-contract'
import { CONNECTION_REFUSAL_CODES } from '../../ops/connections/refusals'
import {
  CONNECTION_ROUTE_REFUSAL_CODES, CREATE_REFUSAL_CODES, CREATE_ROUTE_REFUSAL_CODES, NOT_VERIFY_REFUSALS, connectionRouteSentence, createRefusalSentence,
  type RefusalContext, type RouteRefusalContext,
} from '../connection-create-refusals'

const CTX: RefusalContext = {
  service: 'Salesforce', secret: 'client secret', org: 'lendco.my.salesforce.com', names: ['Client id'], money: 'snowflake_user',
}

/** The writing rule's forbidden marks (long dashes, curly quotes), built from char codes so this file holds none. */
const FORBIDDEN_MARKS = [0x2014, 0x2013, 0x2018, 0x2019, 0x201c, 0x201d].map((c) => String.fromCharCode(c))
const SPACED_HYPHEN = ` ${String.fromCharCode(0x2d)} `

describe('the create refusals', () => {
  it('cover every code the route can answer: its own, and every code verify can answer', () => {
    const verifyCodes = [
      ...OPS_CONNECTIONS_REFUSAL_CODES.filter((c) => !(NOT_VERIFY_REFUSALS as readonly string[]).includes(c)),
      ...CONNECTION_REFUSAL_CODES,
      'ops_connections_unavailable',
    ]
    expect([...CREATE_REFUSAL_CODES].sort()).toEqual([...new Set([...CREATE_ROUTE_REFUSAL_CODES, ...verifyCodes])].sort())
  })

  it('leave out only codes verify never answers', () => {
    // The Google list's methods, the lookups', health's, revoke's and the Reconnect's clearing.
    for (const code of NOT_VERIFY_REFUSALS) {
      expect(code).toMatch(/^(delegation_|lookup_|health_|revoke_|reauth_clear_)/)
    }
  })

  it.each([...CREATE_REFUSAL_CODES])('%s has its own sentence: what failed, that nothing was saved, what to do', (code) => {
    const sentence = createRefusalSentence(code, CTX)
    expect(sentence).toMatch(/^[A-Z0-9].*\. Nothing was saved\. [A-Z].*\.$/)
    for (const mark of [...FORBIDDEN_MARKS, SPACED_HYPHEN]) expect(sentence).not.toContain(mark)
    expect(sentence).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  it('gives each code a sentence of its own, never one shared by two causes (L11)', () => {
    const seen = new Map<string, string>()
    const shared: string[] = []
    for (const code of CREATE_REFUSAL_CODES) {
      const s = createRefusalSentence(code, CTX)
      if (seen.has(s)) shared.push(`${code} and ${seen.get(s)}`)
      seen.set(s, code)
    }
    expect(shared).toEqual([])
  })

  it('says the design\'s own sentence when Salesforce refuses the client secret (D14)', () => {
    // Word for word as docs/design/connections-page.checks.js D14 reads it: the secret is named once (L605).
    expect(createRefusalSentence('connection_needs_reauth', CTX)).toBe('Salesforce refused the client secret. Nothing was saved. Check the secret and save again.')
    expect(createRefusalSentence('connection_needs_reauth', { ...CTX, service: 'Snowflake', secret: 'private key' })).toBe('Snowflake refused the private key. Nothing was saved. Check the secret and save again.')
    expect(createRefusalSentence('connection_needs_reauth', { ...CTX, service: 'Lender API', secret: 'login' })).toBe('Lender API refused the login. Nothing was saved. Check the login and save again.')
  })

  // Word for word as Dan settled it in design round 33 (2026-10-21), the org's address filled in.
  it('says no limit is set yet on the calls to the org, and to ask Dan to set one (#2556, round 33)', () => {
    expect(createRefusalSentence('sf_cap_unset', CTX)).toBe(
      'Bidspoke has no limit set yet on how many Salesforce calls its workflows may make to lendco.my.salesforce.com, so it cannot connect to that org. Nothing was saved. Ask Dan to set a limit for this org, then save again.',
    )
  })

  it('names each mailbox or drive not on the company list', () => {
    expect(createRefusalSentence('google_subject_not_listed', { ...CTX, names: ['ops@trypennie.com', 'Finance drive'] }))
      .toContain('ops@trypennie.com and Finance drive are not on the company list')
  })
})

describe('the Reconnect, Remove and Google list refusals (build PR 6)', () => {
  const ROUTE_CTX: RouteRefusalContext = { service: 'Salesforce', secret: 'client secret', names: ['Achieve report import'], deleted: false }

  it('cover every ops refusal those routes pass on: the Reconnect\'s clearing and the Google list\'s', () => {
    // health's and the lookups' belong to other routes, and a failed revoke is never a refusal: the removal stands.
    const relayed = NOT_VERIFY_REFUSALS.filter((c) => !/^(health_|lookup_)/.test(c) && c !== 'revoke_unrecorded')
    expect(relayed.filter((c) => !(CONNECTION_ROUTE_REFUSAL_CODES as readonly string[]).includes(c))).toEqual([])
    expect(relayed.length).toBeGreaterThanOrEqual(7)
  })

  it.each([...CONNECTION_ROUTE_REFUSAL_CODES])('%s has its own sentence saying what was and was not changed, and what to do', (code) => {
    const sentence = connectionRouteSentence(code, ROUTE_CTX)
    expect(sentence).toMatch(/^[A-Z0-9].*\.$/)
    expect(sentence).toMatch(/Nothing was (saved|changed|removed|added)\.|is saved|is removed|could not confirm/)
    for (const mark of [...FORBIDDEN_MARKS, SPACED_HYPHEN]) expect(sentence).not.toContain(mark)
    expect(sentence).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  it('gives each a sentence of its own, shared with no other route code and no create code (L11)', () => {
    const create = new Set(CREATE_REFUSAL_CODES.map((c) => createRefusalSentence(c, CTX)))
    const seen = new Map<string, string>()
    const shared: string[] = []
    for (const code of CONNECTION_ROUTE_REFUSAL_CODES) {
      const s = connectionRouteSentence(code, ROUTE_CTX)
      if (seen.has(s)) shared.push(`${code} and ${seen.get(s)}`)
      if (create.has(s)) shared.push(`${code} and a create code`)
      seen.set(s, code)
    }
    expect(shared).toEqual([])
  })

  it('names every workflow that uses a connection, deleted ones marked, and says a deleted one needs Dan (D9)', () => {
    const sentence = connectionRouteSentence('connection_in_use', { ...ROUTE_CTX, names: ['Achieve report import', 'Old import (deleted)'], deleted: true })
    expect(sentence).toBe('Achieve report import and Old import (deleted) use this connection, so it cannot be removed. Nothing was removed. Take it out of each of them first, and ask Dan about a deleted one.')
    expect(connectionRouteSentence('connection_in_use', ROUTE_CTX)).toBe('Achieve report import uses this connection, so it cannot be removed. Nothing was removed. Take it out of that workflow first.')
  })

  it('names every connection that acts as a list entry, so it cannot be taken off', () => {
    expect(connectionRouteSentence('delegation_subject_in_use', { ...ROUTE_CTX, names: ['Ops mailbox'], subject: 'ops@trypennie.com' }))
      .toBe('Ops mailbox acts as ops@trypennie.com, so it cannot be taken off the list. Nothing was removed. Remove that connection first.')
  })

  it('says a login saved by a Reconnect whose check did not clear is saved, and what happens next', () => {
    const sentence = connectionRouteSentence('reconnect_saved_check_not_cleared', ROUTE_CTX)
    expect(sentence).toMatch(/^The new client secret is saved/)
    expect(sentence).toMatch(/within a minute/)
    expect(sentence).toMatch(/Reconnect again/)
  })

  it('says a removal the workflows server was not told of still stands, and the real bound on when ops stops using it', () => {
    const sentence = connectionRouteSentence('connection_removed_ops_not_told', ROUTE_CTX)
    expect(sentence).toMatch(/^The connection is removed\./)
    // The ops tick reads the removals every minute; a copy it cannot refresh expires at serve_until, 6 hours (ops-gateway.ts).
    expect(sentence).toMatch(/next minute check/)
    expect(sentence).toMatch(/within 6 hours at the latest/)
  })
})
