/**
 * Every refusal the create route can answer has one plain sentence the page
 * shows (#2338, build PR 5; R14, D14), held in one place. So does every refusal
 * the Reconnect, Remove and Google list routes add (build PR 6; R9, R10, R19,
 * R21), in the same module.
 */
import { describe, expect, it } from 'vitest'
import { CATALOGUE, type ServiceSchema } from '@bidspoke/service-catalogue/schema'
import { keyScopeOf, secretLabelOf } from '../connection-create'
import { OPS_CONNECTIONS_REFUSAL_CODES } from '../ops-connections-contract'
import { CONNECTION_REFUSAL_CODES } from '../../ops/connections/refusals'
import {
  CONNECTION_ROUTE_REFUSAL_CODES, CREATE_REFUSAL_CODES, CREATE_ROUTE_REFUSAL_CODES, NOT_VERIFY_REFUSALS, connectionRouteSentence, createRefusalSentence,
  type CreateRefusalCode, type RefusalContext, type RouteRefusalContext, type TargetFrom,
} from '../connection-create-refusals'

const CTX: RefusalContext = {
  service: 'Salesforce', secret: 'client secret', org: 'lendco.my.salesforce.com', names: ['Client id'], money: 'snowflake_user', targetFrom: 'form',
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
    // The Google list's methods, the lookups', health's, revoke's, the Reconnect's clearing, signInClient's and exchangeOAuthCode's (#2338, build PR 13) and the step test's (#2339).
    for (const code of NOT_VERIFY_REFUSALS) {
      expect(code).toMatch(/^(delegation_|lookup_|health_|revoke_|reauth_clear_|sign_in_|exchange_|step_test_)/)
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

  // OpenAI answers a key used with a Project ID it cannot act in with the same 401 as a bad key: its error
  // reference documents no code that tells them apart (#2715), so the sentence names both and which to check first.
  it('says a refused key on a connection that names a project means the key or the Project ID is wrong, Project ID first (#2715)', () => {
    const openai: RefusalContext = { ...CTX, service: 'OpenAI', secret: 'api key', org: null, names: [], keyScope: { key: 'API key', scope: 'Project ID', owner: 'project' } }
    expect(createRefusalSentence('connection_needs_reauth', openai)).toBe(
      'OpenAI refused the API key with this Project ID, so either the key or the Project ID is wrong. Nothing was saved. Check the Project ID first, then the key, and save again.',
    )
    // A service whose key names no scope keeps the design's sentence (D14).
    expect(createRefusalSentence('connection_needs_reauth', { ...openai, keyScope: null })).toBe('OpenAI refused the api key. Nothing was saved. Check the secret and save again.')
  })

  // Reconnect takes the Project ID from the stored connection and refuses a changed one (reconnect_target_changed),
  // so there a refusal may only send the person to the key, the one thing they can change (L111, #2715 review).
  it('on Reconnect, where the Project ID cannot change, sends the person to the key alone (#2715)', () => {
    const fixed: RefusalContext = { ...CTX, service: 'OpenAI', secret: 'api key', org: null, names: [], keyScope: { key: 'API key', scope: 'Project ID', owner: 'project' }, targetFrom: 'stored' }
    const reauth = createRefusalSentence('connection_needs_reauth', fixed)
    expect(reauth).toBe(
      'OpenAI refused the API key with this connection\'s Project ID, so the key is wrong or belongs to another project. Nothing was saved. Check the key is from this connection\'s project and save again.',
    )
    const mismatch = createRefusalSentence('verify_openai_project_mismatch', fixed)
    expect(mismatch).toBe(
      'OpenAI says this API key belongs to another project than this connection\'s Project ID. Nothing was saved. Check the key is from this connection\'s project and save again.',
    )
    for (const sentence of [reauth, mismatch]) {
      expect(sentence).not.toMatch(/Check the Project ID/)
      expect(sentence).not.toMatch(/Project ID is wrong/)
    }
    // Where the Project ID can still be changed (Add), both keep sending the person to it.
    const open: RefusalContext = { ...fixed, targetFrom: 'form' }
    expect(createRefusalSentence('connection_needs_reauth', open)).toMatch(/Check the Project ID first, then the key/)
    expect(createRefusalSentence('verify_openai_project_mismatch', open)).toBe('OpenAI says this API key belongs to another project than the Project ID entered. Nothing was saved. Check the Project ID and save again.')
  })

  it('reads the key and its scope from the OpenAI form\'s own labels, and names no scope for any other service (#2715)', () => {
    const service = (key: string) => {
      const found = CATALOGUE.find((s) => s.key === key)
      if (found === undefined) throw new Error(`the catalogue declares no ${key}`)
      return found
    }
    expect(keyScopeOf(service('openai'))).toEqual({ key: 'API key', scope: 'Project ID', owner: 'project' })
    for (const s of CATALOGUE.filter((s) => s.key !== 'openai')) expect(keyScopeOf(s), s.key).toBeNull()
  })

  it('refuses loudly when the OpenAI form no longer has the field its key is scoped to, rather than dropping the scope (#2715)', () => {
    const openai = CATALOGUE.find((s) => s.key === 'openai')
    if (openai === undefined) throw new Error('the catalogue declares no openai')
    const renamed: ServiceSchema = { ...openai, connection: { ...openai.connection, fields: openai.connection.fields.filter((f) => f.key !== 'project_id') } }
    expect(() => keyScopeOf(renamed)).toThrow(/project_id/)
  })

  it("keeps the secret label's own capitals in every catalogue service's refused sentence (#2889)", () => {
    const anthropic = CATALOGUE.find((s) => s.key === 'anthropic')!
    expect(createRefusalSentence('connection_needs_reauth', { ...CTX, service: anthropic.name, secret: secretLabelOf(anthropic) }))
      .toBe('Anthropic refused the API key. Nothing was saved. Check the secret and save again.')
    for (const s of CATALOGUE) {
      const sentence = createRefusalSentence('connection_needs_reauth', { ...CTX, service: s.name, secret: secretLabelOf(s) })
      const field = s.connection.fields.find((f) => f.input === 'secret' || f.input === 'secret_block')
      for (const w of field?.label.split(' ') ?? []) {
        if ((w.match(/[A-Z]/g) ?? []).length > 1) expect(sentence, s.key).toContain(` ${w} `)
      }
      expect(sentence, s.key).not.toMatch(/\bapi\b/)
    }
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

// Reconnect takes what a connection names (its target: a Workspace ID, a Project ID, an address) from the stored
// row and refuses a changed one (reconnect_target_changed), and a Google sign in, new or a Reconnect, is for the
// person's own account, which nobody types, so no sentence either shows may send the person to check or change it
// (L111, #2910). These walk every code by the state reached, never a list of the sentences known to name a target
// (L247), for every catalogue service, since each names its target in its own words.
describe('on Reconnect, where the target is stored, and on a sign in, where nobody types one (#2910)', () => {
  const KEPT: readonly Exclude<TargetFrom, 'form'>[] = ['stored', 'sign_in']
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  /** Words for what a connection names that a sentence uses besides the form's own labels. */
  const TARGET_WORDS = ['address', 'host', 'account', 'mailbox', 'workspace', 'project', 'org', 'connected app', 'client id', 'both', 'what the connection names', 'the services']
  /** An instruction to the person: the verbs a remedy uses to send them to a field. */
  const INSTRUCTION = /\b(check|choose|use|change|enter|tick|fill|fix|type|correct|pick|edit)\b/i

  /**
   * Each part of the sentence that sends the person to something they cannot change there, or says it is wrong.
   * Allowed: what "this connection" names as the thing to match (it is read, not changed), the login's own
   * fields, and on Reconnect adding a new connection, which is where a stored target that is itself wrong is
   * fixed. A sign in is itself the adding of a connection, so there a new connection is no remedy either.
   */
  function asksForTarget(sentence: string, service: ServiceSchema, from: Exclude<TargetFrom, 'form'> = 'stored'): string[] {
    const found: string[] = []
    if (from === 'sign_in' && /add a new connection/i.test(sentence)) found.push('add a new connection')
    const targetLabels = service.connection.fields.filter((f) => f.target !== undefined).map((f) => f.label)
    const loginLabels = [secretLabelOf(service), ...service.connection.fields.filter((f) => f.login !== undefined && f.target === undefined).map((f) => f.label)]
      .sort((a, b) => b.length - a.length)
    let text = sentence
      .replace(/add a new connection[^.]*/gi, '')
      .replace(/(the one )?this (connection|one) names/gi, '')
      .replace(/this connection's [A-Za-z]+( (ID|URL|id|path|app))?/g, '')
    for (const label of loginLabels) text = text.replace(new RegExp(escape(label), 'gi'), '')
    const terms = new RegExp(`\\b(${[...targetLabels, ...TARGET_WORDS].map(escape).join('|')})\\b`, 'i')
    const [, remedy = ''] = text.split(/Nothing was (?:saved|changed|removed|added)\./)
    for (const part of remedy.split(/(?<=\.)\s+/)) {
      if (INSTRUCTION.test(part) && terms.test(part)) found.push(part.trim())
    }
    const wrong = new RegExp(`\\b(${[...targetLabels, ...TARGET_WORDS].map(escape).join('|')}) is wrong\\b`, 'i')
    if (wrong.test(text)) found.push(text.match(wrong)![0])
    return found
  }

  const keptCtx = (s: ServiceSchema, from: Exclude<TargetFrom, 'form'> = 'stored'): RefusalContext => ({
    service: s.name, secret: secretLabelOf(s), org: 'lendco.my.salesforce.com', names: ['Finance drive', 'Salesforce'], money: 'snowflake_user',
    keyScope: keyScopeOf(s), targetFrom: from,
  })

  it('no sentence sends the person to check or change what the connection names, for any service, on Reconnect or a sign in', () => {
    const asks: string[] = []
    for (const s of CATALOGUE) {
      for (const from of KEPT) {
        for (const code of CREATE_REFUSAL_CODES) {
          const sentence = createRefusalSentence(code, keptCtx(s, from))
          for (const part of asksForTarget(sentence, s, from)) asks.push(`${from} ${s.key} ${code}: "${part}" in "${sentence}"`)
        }
      }
      for (const code of CONNECTION_ROUTE_REFUSAL_CODES) {
        const sentence = connectionRouteSentence(code, { service: s.name, secret: secretLabelOf(s), names: ['api.lender.example'], deleted: false })
        for (const part of asksForTarget(sentence, s)) asks.push(`${s.key} ${code}: "${part}" in "${sentence}"`)
      }
    }
    expect(asks).toEqual([])
  })

  it('the check itself catches a sentence that sends the person to the target (it is seen to fail)', () => {
    const service = (key: string) => CATALOGUE.find((s) => s.key === key)!
    expect(asksForTarget('Slack says no. Nothing was saved. Check the Workspace ID and save again.', service('slack'))).not.toEqual([])
    expect(asksForTarget('A says no. Nothing was saved. Check the address and save again.', service('http'))).not.toEqual([])
    expect(asksForTarget('OpenAI refused it, so either the key or the Project ID is wrong. Nothing was saved. Save again.', service('openai'))).not.toEqual([])
    expect(asksForTarget('No. Nothing was saved. Check the Header value and save again.', service('http'))).toEqual([])
    expect(asksForTarget('No. Nothing was saved. Add a new connection with another host.', service('http'))).toEqual([])
    // A sign in is the adding of a connection, so a new one is no remedy there.
    expect(asksForTarget('No. Nothing was saved. Add a new connection with another host.', service('google'), 'sign_in')).not.toEqual([])
  })

  /**
   * Each part of a sign in sentence that asks for a save. A sign in saves no form: what starts it again is
   * signing in again (#2923). "Nothing was saved." says what happened, so it is the one allowed.
   */
  function asksToSave(sentence: string): string[] {
    return sentence.replace(/Nothing was saved\./g, '').match(/[^.]*\bsav(?:e|ed|es|ing)\b[^.]*\.?/gi)?.map((p) => p.trim()) ?? []
  }

  it('no sign in sentence asks for a save, for any code and any service, since a sign in saves no form (#2923)', () => {
    const asks: string[] = []
    for (const s of CATALOGUE) {
      for (const code of CREATE_REFUSAL_CODES) {
        // Every shape a context can take that changes the words: a key with a scope, each bidding identity, an org or none.
        for (const ctx of [keptCtx(s, 'sign_in'), { ...keptCtx(s, 'sign_in'), keyScope: null, money: null, org: null, names: [] }]) {
          const sentence = createRefusalSentence(code, ctx)
          for (const part of asksToSave(sentence)) asks.push(`${s.key} ${code}: "${part}" in "${sentence}"`)
        }
      }
    }
    expect(asks).toEqual([])
  })

  it('the save check itself catches a sentence that asks for a save, and lets "Nothing was saved." through (it is seen to fail)', () => {
    expect(asksToSave('No. Nothing was saved. Save again in a minute.')).toEqual(['Save again in a minute.'])
    expect(asksToSave('No. Nothing was saved. Check the login and save again.')).toEqual(['Check the login and save again.'])
    expect(asksToSave('No. Nothing was saved. Dan must approve one before a connection to it can be saved.')).not.toEqual([])
    expect(asksToSave('No. Nothing was saved. Sign in with Google again in a minute.')).toEqual([])
  })

  it.each([...CREATE_REFUSAL_CODES])('%s keeps the pattern on Reconnect and a sign in: what failed, that nothing was saved, what to do', (code) => {
    for (const s of CATALOGUE) {
      for (const from of KEPT) {
        const sentence = createRefusalSentence(code, keptCtx(s, from))
        expect(sentence, `${from} ${s.key}`).toMatch(/^[A-Z0-9].*\. Nothing was saved\. [A-Z].*\.$/)
        for (const mark of [...FORBIDDEN_MARKS, SPACED_HYPHEN]) expect(sentence, `${from} ${s.key}`).not.toContain(mark)
      }
    }
  })

  it('gives each code a sentence of its own on Reconnect and a sign in too (L11)', () => {
    for (const s of CATALOGUE) {
      for (const from of KEPT) {
        const seen = new Map<string, string>()
        const shared: string[] = []
        for (const code of CREATE_REFUSAL_CODES) {
          const sentence = createRefusalSentence(code, keptCtx(s, from))
          if (seen.has(sentence)) shared.push(`${code} and ${seen.get(sentence)}`)
          seen.set(sentence, code)
        }
        expect(shared, `${from} ${s.key}`).toEqual([])
      }
    }
  })

  it('on a Google sign in, new or a Reconnect, sends the person to signing in again, or to Dan where Bidspoke decides it', () => {
    const signIn: RefusalContext = { ...CTX, service: 'Google', secret: 'login', org: null, names: [], targetFrom: 'sign_in' }
    expect(createRefusalSentence('connection_target_invalid', signIn)).toBe(
      'Bidspoke asked Google for a sign in it cannot use. Nothing was saved. Tell Dan, since this is a fault in Bidspoke.',
    )
    expect(createRefusalSentence('connection_not_allowed', signIn)).toBe('A Bidspoke rule refused this Google login before it was tried. Nothing was saved. Tell Dan.')
    expect(createRefusalSentence('connection_host_not_declared', signIn)).toBe(
      'Google sent the check to an address this connection does not name. Nothing was saved. Tell Dan, since this is a fault in Bidspoke.',
    )
    expect(createRefusalSentence('verify_google_mailbox_mismatch', signIn)).toBe(
      'Google says this acts as another mailbox than the one this connection names. Nothing was saved. Sign in with Google again, and tell Dan if it keeps happening.',
    )
  })

  // The general refusals a sign in shares with Add and Reconnect end in signing in again, at once, in a minute,
  // or with Dan told if it repeats, never in a form's save (#2923).
  it('on a Google sign in, words the shared refusals as signing in again, never as saving a form (#2923)', () => {
    const signIn: RefusalContext = { ...CTX, service: 'Google', secret: 'login', org: null, names: [], money: null, targetFrom: 'sign_in' }
    const said: Record<string, string> = {
      connection_auth_failed: 'The sign in to Google failed for a reason it did not give. Nothing was saved. Sign in with Google again, and tell Dan if it keeps happening.',
      connection_network_error: 'Bidspoke could not reach Google. Nothing was saved. Sign in with Google again in a minute.',
      connection_timeout: 'Google took too long to answer. Nothing was saved. Sign in with Google again.',
      connection_rate_limited: 'Google asked Bidspoke to wait. Nothing was saved. Sign in with Google again in a few minutes.',
      connection_removed: 'This connection was removed while it was being checked. Nothing was saved. Sign in with Google again.',
      connections_unavailable: 'Bidspoke\'s database did not answer. Nothing was saved. Sign in with Google again in a minute.',
      connection_store_failed: 'The login worked, but Bidspoke could not store the connection. Nothing was saved. Sign in with Google again, and tell Dan if it keeps happening.',
      connection_seal_failed: 'Bidspoke could not lock the login away for safe keeping. Nothing was saved. Sign in with Google again, and tell Dan if it keeps happening.',
      connection_name_taken: 'Another Google connection already has that name. Nothing was saved. Choose another name and sign in with Google again.',
      verify_timed_out: 'The login check with Google did not finish in time. Nothing was saved. Sign in with Google again.',
      verify_refused_unknown: 'The login check with Google failed for a reason Bidspoke does not know. Nothing was saved. Sign in with Google again, and tell Dan if it keeps happening.',
      ops_connections_timeout: 'The workflows server stopped the check with Google because it took too long. Nothing was saved. Sign in with Google again.',
      ops_connections_unavailable: 'The workflows server did not answer. Nothing was saved. Sign in with Google again in a minute.',
      candidate_not_refreshable: 'The workflows server would not take this Google sign in as a new login. Nothing was saved. Tell Dan, since this is a fault in Bidspoke.',
    }
    for (const [code, sentence] of Object.entries(said)) expect(createRefusalSentence(code as CreateRefusalCode, signIn), code).toBe(sentence)
  })

  it('leaves the Add and Reconnect wording of the shared refusals as it was (#2923)', () => {
    for (const from of ['form', 'stored'] as const) {
      const ctx: RefusalContext = { ...CTX, service: 'Google', secret: 'login', org: null, names: [], money: null, targetFrom: from }
      expect(createRefusalSentence('connection_auth_failed', ctx)).toBe('The sign in to Google failed for a reason it did not give. Nothing was saved. Check the login and save again.')
      expect(createRefusalSentence('connection_network_error', ctx)).toBe('Bidspoke could not reach Google. Nothing was saved. Save again in a minute.')
      expect(createRefusalSentence('connection_timeout', ctx)).toBe('Google took too long to answer. Nothing was saved. Save again.')
      expect(createRefusalSentence('connection_removed', ctx)).toBe('This connection was removed while it was being checked. Nothing was saved. Save it again.')
      expect(createRefusalSentence('connection_name_taken', ctx)).toBe('Another Google connection already has that name. Nothing was saved. Choose another name and save again.')
      expect(createRefusalSentence('candidate_not_refreshable', ctx)).toBe('A personal Google login is added by signing in, not with this form. Nothing was saved. Use the sign in button instead.')
      expect(createRefusalSentence('sf_purpose_cap_unset', { ...ctx, service: 'Salesforce', org: 'lendco.my.salesforce.com' })).toBe(
        'Bidspoke has no approved share for checking logins on the Salesforce org lendco.my.salesforce.com. Nothing was saved. Dan must approve one for this org before a connection to it can be saved.',
      )
    }
  })

  it('words the four the issue names for the key, or a new connection where the stored target is wrong', () => {
    const stored: RefusalContext = { ...CTX, org: null, names: [], targetFrom: 'stored' }
    expect(createRefusalSentence('verify_slack_workspace_mismatch', { ...stored, service: 'Slack', secret: 'Bot token' })).toBe(
      'Slack says this bot is in another workspace than this connection\'s Workspace ID. Nothing was saved. Use a bot token from the ops Slack app in this connection\'s workspace and save again.',
    )
    expect(createRefusalSentence('verify_anthropic_workspace_mismatch', { ...stored, service: 'Anthropic', secret: 'API key' })).toBe(
      'Anthropic says this API key runs in another workspace than this connection\'s Workspace ID. Nothing was saved. Check the key is from this connection\'s workspace and save again.',
    )
    expect(createRefusalSentence('connection_target_invalid', { ...stored, service: 'Snowflake' })).toBe(
      'The Snowflake address this connection names is not one Bidspoke can use. Nothing was saved. To use another, add a new connection.',
    )
    expect(createRefusalSentence('connection_host_not_declared', { ...stored, service: 'Salesforce' })).toBe(
      'Salesforce sent the check to an address this connection does not name. Nothing was saved. Tell Dan, or add a new connection if this one names the wrong address.',
    )
  })

  it('keeps a Slack alert bot refusal on the token, which Reconnect can change, and sends any other bidding identity to a new connection', () => {
    const stored: RefusalContext = { ...CTX, targetFrom: 'stored' }
    expect(createRefusalSentence('connection_money_identity', { ...stored, money: 'slack_alert_bot' })).toMatch(/Nothing was saved\. Use a login made for workflows\.$/)
    for (const money of ['supabase_project', 'salesforce_client_id', 'snowflake_user'] as const) {
      expect(createRefusalSentence('connection_money_identity', { ...stored, money }), money).toMatch(/Nothing was saved\. Add a new connection with a login made for workflows\.$/)
    }
  })

  it('leaves every Add sentence as it was', () => {
    const add: RefusalContext = { ...CTX, targetFrom: 'form' }
    expect(createRefusalSentence('verify_slack_workspace_mismatch', add)).toBe('Slack says this bot is in another workspace than the Workspace ID entered. Nothing was saved. Check the Workspace ID and save again.')
    expect(createRefusalSentence('verify_anthropic_workspace_mismatch', add)).toBe('Anthropic says this API key runs in another workspace than the Workspace ID entered. Nothing was saved. Check the Workspace ID and save again.')
    expect(createRefusalSentence('connection_target_invalid', add)).toBe('The Salesforce address entered is not one Bidspoke can use. Nothing was saved. Check the address and save again.')
    expect(createRefusalSentence('connection_url_invalid', add)).toBe('The check was sent to an address that is not a secure Salesforce one. Nothing was saved. Check the address and save again.')
    expect(createRefusalSentence('connection_host_not_declared', add)).toBe('Salesforce sent the check to an address this connection does not name. Nothing was saved. Check the address and save again.')
    expect(createRefusalSentence('verify_client_id_mismatch', add)).toBe('The client secret belongs to another connected app than the client id. Nothing was saved. Check both and save again.')
    expect(createRefusalSentence('verify_identity_mismatch', add)).toBe('Salesforce says this login belongs to another account than the one entered. Nothing was saved. Check the account and save again.')
    expect(createRefusalSentence('verify_google_mailbox_mismatch', add)).toBe('Google says this acts as another mailbox than the one chosen. Nothing was saved. Choose the mailbox again from the company list and save.')
    expect(createRefusalSentence('verify_http_check_refused', add)).toBe('The Check path did not answer with this header value. Nothing was saved. Check the Check path, the Header and the Header value, and save again.')
    expect(createRefusalSentence('verify_supabase_lane_project', add)).toBe('This is one of the Supabase projects Bidspoke itself runs on, which a workflow connection may never use. Nothing was saved. Use a project made for workflows.')
    expect(createRefusalSentence('connection_not_allowed', add)).toBe('A Bidspoke rule refused this Salesforce login before it was tried. Nothing was saved. Check what the connection names and save again.')
    expect(createRefusalSentence('connection_service_undeclared', add)).toBe('Bidspoke cannot connect to Salesforce yet. Nothing was saved. Choose one of the services the form offers.')
    expect(createRefusalSentence('connection_host_owned', { ...add, names: ['api.slack.com', 'Slack'] })).toBe('The host api.slack.com belongs to Slack, which an HTTP connection may never reach. Nothing was saved. Use another host, or a Slack connection where Bidspoke offers one.')
    expect(createRefusalSentence('connection_money_host', { ...add, names: ['api.lender.example'] })).toBe('The host api.lender.example is one Bidspoke\'s bidding sends to, which a workflow connection may never reach. Nothing was saved. Use another host.')
    expect(createRefusalSentence('google_subject_is_drive', { ...add, names: ['Finance drive'] })).toBe('Finance drive is a shared drive, and a Google connection acts as a mailbox. Nothing was saved. Choose a mailbox under Acts as, tick the drive under Shared drives, then save again.')
    expect(createRefusalSentence('money_identity_match', add)).toBe('This login signs in as the Salesforce user Bidspoke bids as, which a workflow connection may never use. Nothing was saved. Use a login made for workflows.')
    expect(createRefusalSentence('connection_money_identity', add)).toBe('This is a Snowflake user Bidspoke\'s bidding signs in as, which a workflow connection may never use. Nothing was saved. Use a login made for workflows.')
  })
})

describe('the Reconnect, Remove and Google list refusals (build PR 6)', () => {
  const ROUTE_CTX: RouteRefusalContext = { service: 'Salesforce', secret: 'client secret', names: ['Achieve report import'], deleted: false }

  it('cover every ops refusal those routes pass on: the Reconnect\'s clearing and the Google list\'s', () => {
    // health's, the lookups', signInClient's, exchangeOAuthCode's and the step test's belong to other routes (the sign in route words its own), and a failed revoke is never a refusal: the removal stands.
    const relayed = NOT_VERIFY_REFUSALS.filter((c) => !/^(health_|lookup_|sign_in_|exchange_|step_test_)/.test(c) && c !== 'revoke_unrecorded')
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
