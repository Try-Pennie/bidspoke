/**
 * Every refusal the create route can answer has one plain sentence the page
 * shows (#2338, build PR 5; R14, D14), held in one place.
 */
import { describe, expect, it } from 'vitest'
import { OPS_CONNECTIONS_REFUSAL_CODES } from '../ops-connections-contract'
import { CONNECTION_REFUSAL_CODES } from '../../ops/connections/refusals'
import {
  CREATE_REFUSAL_CODES, CREATE_ROUTE_REFUSAL_CODES, NOT_VERIFY_REFUSALS, createRefusalSentence, type RefusalContext,
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
    expect(createRefusalSentence('connection_needs_reauth', CTX)).toBe('Salesforce refused the client secret. Nothing was saved. Check the client secret and save again.')
  })

  it('names the org and that Dan must approve a cap for it when it has none (#2556)', () => {
    expect(createRefusalSentence('sf_cap_unset', CTX)).toBe(
      'Bidspoke has no approved cap for the Salesforce org lendco.my.salesforce.com. Nothing was saved. Dan must approve a cap for this org before a connection to it can be saved.',
    )
  })

  it('names each mailbox or drive not on the company list', () => {
    expect(createRefusalSentence('google_subject_not_listed', { ...CTX, names: ['ops@trypennie.com', 'Finance drive'] }))
      .toContain('ops@trypennie.com and Finance drive are not on the company list')
  })
})
