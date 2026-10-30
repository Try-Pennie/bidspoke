/**
 * What crosses the OPS_CONNECTIONS binding (#2335, PR 8 of phase 5 of #1689):
 * each request is parsed on ops before anything is read or opened (L50), and a
 * malformed one is refused by name, naming a field and never a value.
 */
import { describe, expect, it } from 'vitest'
import {
  LOOKUP_RATE_PER_MINUTE, OPS_CONNECTIONS_CEILINGS_MS, OPS_CONNECTIONS_METHODS, OPS_DELEGATION_METHODS, OPS_SIGN_IN_METHODS,
  OPS_STEP_TEST_METHODS, STEP_TEST_CONTEXT_MAX_BYTES, parseStepTestResultRequest, parseTestStepRequest,
  OpsConnectionsContractError, parseAddDelegationSubjectRequest, parseClearReauthRequest, parseExchangeOAuthCodeRequest, parseHealthRequest,
  parseListDelegationSubjectsRequest, parseLookupRequest, parseRemoveDelegationSubjectRequest, parseRevokeRequest, parseSignInClientRequest, parseVerifyRequest,
} from '../ops-connections-contract'

const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const CONN = '0199f0a0-0000-7000-8000-000000000001'
const ENVELOPE = { v: 1, kid: 'ops-2026-10', wrapped_key: 'd3JhcHBlZA==', iv: 'aXY=', ct: 'Y3Q=' }
const CANDIDATE = {
  service: 'salesforce', generation: 2, envelope: ENVELOPE,
  target: { instance_url: 'https://ops.my.salesforce.com', client_id: 'ops-app' }, public_config: { name: 'ops salesforce' },
}

function refused(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof OpsConnectionsContractError) return err.message
    throw err
  }
  throw new Error('expected a refusal, and the request parsed')
}

describe('the OpsConnections contract', () => {
  it('names the methods the entrypoint answers, and a ceiling for each', () => {
    expect([...OPS_CONNECTIONS_METHODS].sort()).toEqual([
      'addDelegationSubject', 'clearReauth', 'exchangeOAuthCode', 'health', 'listDelegationSubjects', 'lookup', 'removeDelegationSubject', 'revoke', 'signInClient',
      'stepTestResult', 'testStep', 'verify',
    ])
    expect(Object.keys(OPS_CONNECTIONS_CEILINGS_MS).sort()).toEqual([...OPS_CONNECTIONS_METHODS].sort())
    for (const ms of Object.values(OPS_CONNECTIONS_CEILINGS_MS)) expect(ms).toBeGreaterThan(0)
    expect(LOOKUP_RATE_PER_MINUTE).toBeGreaterThanOrEqual(1)
    expect(LOOKUP_RATE_PER_MINUTE).toBeLessThanOrEqual(600)
  })

  it('calls the sign in method, which shipped on ops first (#2338, build PR 13a), among the methods bidding calls', () => {
    expect([...OPS_SIGN_IN_METHODS]).toEqual(['signInClient'])
    for (const m of OPS_SIGN_IN_METHODS) expect(OPS_CONNECTIONS_METHODS as readonly string[]).toContain(m)
  })

  it('calls the step test methods, which shipped on ops first (#2339), among the methods bidding calls, each with its ceiling (#2764)', () => {
    expect([...OPS_STEP_TEST_METHODS]).toEqual(['testStep', 'stepTestResult'])
    for (const m of OPS_STEP_TEST_METHODS) expect(OPS_CONNECTIONS_METHODS as readonly string[]).toContain(m)
    expect(OPS_CONNECTIONS_CEILINGS_MS.testStep).toBe(90_000)
    expect(OPS_CONNECTIONS_CEILINGS_MS.stepTestResult).toBe(10_000)
  })

  describe('a step test request (#2339)', () => {
    const WF = '0199f0a0-0000-7000-8000-0000000000aa'
    const DAN = '0199f0a0-0000-7000-8000-0000000000d1'
    const node = { id: 'node_1', namespace: 'find_files', config: { service: 'google', action: 'google.drive-list-files' } }
    const ok = { organization_id: ORG, workflow_id: WF, tested_by: DAN, node, trigger_payload: { a: 1 }, steps: { earlier: { output: { b: 2 }, status: 'completed' } }, confirm_send: false }

    it('reads the organization, workflow, tester, step, its context and the confirmation', () => {
      expect(parseTestStepRequest({ ...ok, organization_id: ORG.toUpperCase(), extra: 'ignored' })).toEqual({ ...ok, execution_id: null, variables: null })
      // No context is an empty one, and no confirmation is none.
      const { trigger_payload: _t, steps: _s, confirm_send: _c, ...bare } = ok
      expect(parseTestStepRequest(bare)).toEqual({ ...bare, execution_id: null, trigger_payload: {}, steps: {}, confirm_send: false, variables: null })
    })

    // The two Workers deploy from one commit, but either can be rolled back alone,
    // so a field this release does not read is ignored, never a reason to refuse
    // the test: whatever its shape, beside the request, its node or an earlier step.
    it('ignores a field it does not read, beside the request, its node or an earlier step, whatever its shape, and keeps none of it (#3136)', () => {
      for (const extra of [{ number: 7, values: { K: 1 } }, 'x', [1], null]) {
        const read = parseTestStepRequest({
          ...ok, unread: extra,
          node: { ...node, unread: extra },
          steps: { earlier: { output: { b: 2 }, status: 'completed', unread: extra } },
        })
        expect(read).toEqual({ ...ok, execution_id: null, variables: null })
      }
    })

    // #3002: bidding sends the current values of the variables the step reads,
    // secrets decrypted, and sends none (null) for a step reading none; ops
    // refuses a step reading a variable it was given no value for, and one
    // malformed is refused, never quoting a value.
    it('reads the current variables the step is given, secrets included (#3002), and none when none are sent', () => {
      const variables = { values: { API_BASE: 'https://api.example.test' }, secret_values: { TOKEN: 'tok-live-value' } }
      expect(parseTestStepRequest({ ...ok, variables }).variables).toEqual({ values: { API_BASE: 'https://api.example.test' }, secretValues: { TOKEN: 'tok-live-value' } })
      expect(parseTestStepRequest({ ...ok, variables: null }).variables).toBeNull()
      expect(parseTestStepRequest(ok).variables).toBeNull()
      const secret = 'tok-never-echoed'
      for (const bad of [
        { values: {} }, { values: {}, secret_values: {}, extra: 1 }, { values: { K: 1 }, secret_values: {} }, { values: {}, secret_values: { 'not a name': secret } },
        { values: { TOKEN: secret }, secret_values: { TOKEN: secret } }, 'v', [],
      ]) {
        const said = refused(() => parseTestStepRequest({ ...ok, variables: bad }))
        expect(said).toMatch(/variables/)
        expect(said).not.toContain(secret)
      }
    })

    it('reads a past run to build the context from (#2703): its payload is the run\'s own unless one is given', () => {
      const EXEC = '0199f0a0-0000-7000-8000-0000000000e1'
      const { trigger_payload: _t, steps: _s, ...bare } = ok
      expect(parseTestStepRequest({ ...bare, execution_id: EXEC.toUpperCase() })).toEqual({ ...bare, execution_id: EXEC, trigger_payload: undefined, steps: {}, variables: null })
      // A payload or steps given beside the run replace the run's, as a test from a money run's data does.
      expect(parseTestStepRequest({ ...ok, execution_id: EXEC })).toEqual({ ...ok, execution_id: EXEC, variables: null })
      expect(parseTestStepRequest({ ...bare, execution_id: null })).toMatchObject({ execution_id: null, trigger_payload: {} })
      expect(refused(() => parseTestStepRequest({ ...ok, execution_id: 'exec-1' }))).toMatch(/execution_id/)
      expect(refused(() => parseTestStepRequest({ ...ok, execution_id: 7 }))).toMatch(/execution_id/)
    })

    it('refuses each malformed field by name, never echoing its value', () => {
      expect(refused(() => parseTestStepRequest({ ...ok, workflow_id: 'wf' }))).toMatch(/workflow_id/)
      expect(refused(() => parseTestStepRequest({ ...ok, tested_by: undefined }))).toMatch(/tested_by/)
      expect(refused(() => parseTestStepRequest({ ...ok, node: { ...node, id: '' } }))).toMatch(/node's id/)
      expect(refused(() => parseTestStepRequest({ ...ok, node: { ...node, namespace: 'two words' } }))).toMatch(/node's step id/)
      expect(refused(() => parseTestStepRequest({ ...ok, node: { ...node, config: [] } }))).toMatch(/node's settings/)
      expect(refused(() => parseTestStepRequest({ ...ok, steps: [] }))).toMatch(/steps/)
      expect(refused(() => parseTestStepRequest({ ...ok, steps: { earlier: 'x' } }))).toMatch(/steps/)
      expect(refused(() => parseTestStepRequest({ ...ok, confirm_send: 'yes' }))).toMatch(/confirm_send/)
      const secret = 'sk-live-never-echoed'
      expect(refused(() => parseTestStepRequest({ ...ok, workflow_id: secret }))).not.toContain(secret)
    })

    it(`refuses a context over ${STEP_TEST_CONTEXT_MAX_BYTES} bytes`, () => {
      expect(refused(() => parseTestStepRequest({ ...ok, trigger_payload: { big: 'x'.repeat(STEP_TEST_CONTEXT_MAX_BYTES) } }))).toMatch(/context/)
    })

    it('a result read names the organization, workflow and step', () => {
      expect(parseStepTestResultRequest({ organization_id: ORG, workflow_id: WF.toUpperCase(), node_id: 'node_1' })).toEqual({ organization_id: ORG, workflow_id: WF, node_id: 'node_1' })
      expect(refused(() => parseStepTestResultRequest({ organization_id: ORG, workflow_id: WF }))).toMatch(/node's id/)
    })
  })

  it('a sign in client request names the organization and a service key, and nothing else is read', () => {
    expect(parseSignInClientRequest({ organization_id: ORG.toUpperCase(), service: 'google', client_secret: 'ignored' })).toEqual({ organization_id: ORG, service: 'google' })
    expect(refused(() => parseSignInClientRequest({ service: 'google' }))).toMatch(/organization_id/)
    expect(refused(() => parseSignInClientRequest({ organization_id: ORG, service: 'Google Sheets' }))).toMatch(/service/)
    expect(refused(() => parseSignInClientRequest({ organization_id: ORG }))).toMatch(/service/)
  })

  it('a verify names the organization and connection, with or without a candidate; ids are read lower case, as the seal binds them', () => {
    expect(parseVerifyRequest({ organization_id: ORG.toUpperCase(), connection_id: CONN, candidate: null }))
      .toEqual({ organization_id: ORG, connection_id: CONN, candidate: null })
    expect(parseVerifyRequest({ organization_id: ORG, connection_id: CONN, candidate: CANDIDATE }).candidate).toEqual(CANDIDATE)
    expect(parseVerifyRequest({ organization_id: ORG, connection_id: CONN }).candidate).toBeNull()
  })

  it('refuses a request with no organization or connection uuid, by the field', () => {
    expect(refused(() => parseVerifyRequest({ connection_id: CONN }))).toMatch(/organization_id/)
    expect(refused(() => parseVerifyRequest({ organization_id: 'acme', connection_id: CONN }))).toMatch(/organization_id/)
    expect(refused(() => parseVerifyRequest({ organization_id: ORG, connection_id: 7 }))).toMatch(/connection_id/)
    expect(refused(() => parseVerifyRequest('verify me'))).toMatch(/not an object/)
    expect(refused(() => parseHealthRequest({}))).toMatch(/organization_id/)
  })

  it('refuses a candidate that is not ciphertext and public config only, naming the field and never the value', () => {
    const withSecret = { ...CANDIDATE, public_config: { client_secret: 'canary-client-credential-value' } }
    const message = refused(() => parseVerifyRequest({ organization_id: ORG, connection_id: CONN, candidate: withSecret }))
    expect(message).toMatch(/client_secret/)
    expect(message).not.toContain('canary-client-credential-value')
    expect(refused(() => parseVerifyRequest({ organization_id: ORG, connection_id: CONN, candidate: { ...CANDIDATE, envelope: { ...ENVELOPE, extra: 1 } } }))).toMatch(/envelope/)
    expect(refused(() => parseVerifyRequest({ organization_id: ORG, connection_id: CONN, candidate: { ...CANDIDATE, generation: 0 } }))).toMatch(/generation/)
    expect(refused(() => parseVerifyRequest({ organization_id: ORG, connection_id: CONN, candidate: { ...CANDIDATE, service: 'Sales Force' } }))).toMatch(/service/)
    expect(refused(() => parseVerifyRequest({ organization_id: ORG, connection_id: CONN, candidate: { ...CANDIDATE, target: 'x' } }))).toMatch(/target/)
  })

  it('clearReauth needs its candidate: it verifies the envelope passed in the call', () => {
    expect(parseClearReauthRequest({ organization_id: ORG, connection_id: CONN, candidate: CANDIDATE }).candidate).toEqual(CANDIDATE)
    expect(refused(() => parseClearReauthRequest({ organization_id: ORG, connection_id: CONN, candidate: null }))).toMatch(/candidate/)
  })

  it('revoke names the generation removed and when, on the bidding Worker\'s clock', () => {
    expect(parseRevokeRequest({ organization_id: ORG, connection_id: CONN, generation: 3, removed_at: '2026-10-19T10:00:00.000Z' }))
      .toEqual({ organization_id: ORG, connection_id: CONN, generation: 3, removed_at: '2026-10-19T10:00:00.000Z' })
    expect(refused(() => parseRevokeRequest({ organization_id: ORG, connection_id: CONN, generation: 1.5, removed_at: '2026-10-19T10:00:00.000Z' }))).toMatch(/generation/)
    expect(refused(() => parseRevokeRequest({ organization_id: ORG, connection_id: CONN, generation: 1, removed_at: 'yesterday' }))).toMatch(/removed_at/)
  })

  it('a lookup names a key and at most one parent', () => {
    expect(parseLookupRequest({ organization_id: ORG, connection_id: CONN, key: 'fields', parents: ['Submission__c'] }))
      .toEqual({ organization_id: ORG, connection_id: CONN, key: 'fields', parents: ['Submission__c'] })
    expect(parseLookupRequest({ organization_id: ORG, connection_id: CONN, key: 'objects' }).parents).toEqual([])
    expect(refused(() => parseLookupRequest({ organization_id: ORG, connection_id: CONN, key: '', parents: [] }))).toMatch(/key/)
    expect(refused(() => parseLookupRequest({ organization_id: ORG, connection_id: CONN, key: 'fields', parents: ['a', 'b'] }))).toMatch(/parents/)
    expect(refused(() => parseLookupRequest({ organization_id: ORG, connection_id: CONN, key: 'fields', parents: [3] }))).toMatch(/parents/)
  })

  it('an exchange carries the sealed app login as a candidate, the code, a PKCE verifier of 43 to 128 characters and the redirect URI', () => {
    const ok = {
      organization_id: ORG, connection_id: CONN, candidate: CANDIDATE, code: 'auth-code', verifier: 'v'.repeat(43), redirect_uri: 'https://bidspoke.trypennie.dev/callback',
      expected_account: 'dan@trypennie.com',
    }
    expect(parseExchangeOAuthCodeRequest(ok)).toEqual(ok)
    // The account the person must sign in as (Dan, 2026-10-23): one address, read lower case, and never absent.
    expect(parseExchangeOAuthCodeRequest({ ...ok, expected_account: ' Dan@TryPennie.com ' }).expected_account).toBe('dan@trypennie.com')
    expect(refused(() => parseExchangeOAuthCodeRequest({ ...ok, expected_account: undefined }))).toMatch(/expected_account/)
    expect(refused(() => parseExchangeOAuthCodeRequest({ ...ok, expected_account: 'not an address' }))).toMatch(/expected_account/)
    expect(refused(() => parseExchangeOAuthCodeRequest({ ...ok, verifier: 'v'.repeat(42) }))).toMatch(/verifier/)
    expect(refused(() => parseExchangeOAuthCodeRequest({ ...ok, verifier: 'v'.repeat(129) }))).toMatch(/verifier/)
    expect(refused(() => parseExchangeOAuthCodeRequest({ ...ok, code: '' }))).toMatch(/code/)
    expect(refused(() => parseExchangeOAuthCodeRequest({ ...ok, redirect_uri: 7 }))).toMatch(/redirect_uri/)
    expect(refused(() => parseExchangeOAuthCodeRequest({ ...ok, candidate: null }))).toMatch(/candidate/)
  })
})

describe('the Google mailboxes and drives list (#2338, PR 2)', () => {
  const ACTOR = { user_id: 'cccccccc-0000-4000-8000-000000002338', email: 'dan@example.invalid', name: 'Dan Wright' }

  it('its three methods are OpsConnections methods bidding calls, each with a ceiling, now that the ops deploy carries them (build PR 6)', () => {
    expect(OPS_DELEGATION_METHODS.filter((m) => !(OPS_CONNECTIONS_METHODS as readonly string[]).includes(m))).toEqual([])
    expect([...OPS_DELEGATION_METHODS].sort()).toEqual(['addDelegationSubject', 'listDelegationSubjects', 'removeDelegationSubject'])
    for (const m of OPS_DELEGATION_METHODS) expect(OPS_CONNECTIONS_CEILINGS_MS[m]).toBe(10_000)
  })

  it('an add names the organization, who is adding, the kind, the entry and a drive\'s name', () => {
    expect(parseAddDelegationSubjectRequest({ organization_id: ORG.toUpperCase(), actor: ACTOR, kind: 'drive', subject: '0AbCdEfGhIjKlMnOpQ', display_name: 'Partner reports' }))
      .toEqual({ organization_id: ORG, actor: ACTOR, kind: 'drive', subject: '0AbCdEfGhIjKlMnOpQ', display_name: 'Partner reports' })
    expect(parseAddDelegationSubjectRequest({ organization_id: ORG, actor: { ...ACTOR, name: null }, kind: 'mailbox', subject: 'Ops@Example.invalid' }))
      .toEqual({ organization_id: ORG, actor: { ...ACTOR, name: null }, kind: 'mailbox', subject: 'Ops@Example.invalid', display_name: null })
  })

  it('refuses an add with no actor, an actor with neither a name nor an email, an unknown kind or an entry that is not text, by the field', () => {
    const ok = { organization_id: ORG, actor: ACTOR, kind: 'mailbox', subject: 'ops@example.invalid' }
    expect(refused(() => parseAddDelegationSubjectRequest({ ...ok, actor: undefined }))).toMatch(/actor/)
    expect(refused(() => parseAddDelegationSubjectRequest({ ...ok, actor: { ...ACTOR, user_id: 'dan' } }))).toMatch(/actor/)
    expect(refused(() => parseAddDelegationSubjectRequest({ ...ok, actor: { user_id: ACTOR.user_id, email: null, name: ' ' } }))).toMatch(/actor/)
    expect(refused(() => parseAddDelegationSubjectRequest({ ...ok, kind: 'calendar' }))).toMatch(/kind/)
    expect(refused(() => parseAddDelegationSubjectRequest({ ...ok, subject: 7 }))).toMatch(/subject/)
    expect(refused(() => parseAddDelegationSubjectRequest({ ...ok, subject: 'x'.repeat(321) }))).toMatch(/subject/)
    expect(refused(() => parseAddDelegationSubjectRequest({ ...ok, display_name: 7 }))).toMatch(/display_name/)
    expect(refused(() => parseAddDelegationSubjectRequest({ ...ok, organization_id: 'acme' }))).toMatch(/organization_id/)
  })

  it('a remove names who is removing, the kind and the entry; a list names only the organization', () => {
    expect(parseRemoveDelegationSubjectRequest({ organization_id: ORG, actor: ACTOR, kind: 'mailbox', subject: 'ops@example.invalid' }))
      .toEqual({ organization_id: ORG, actor: ACTOR, kind: 'mailbox', subject: 'ops@example.invalid' })
    expect(refused(() => parseRemoveDelegationSubjectRequest({ organization_id: ORG, kind: 'mailbox', subject: 'ops@example.invalid' }))).toMatch(/actor/)
    expect(parseListDelegationSubjectsRequest({ organization_id: ORG.toUpperCase() })).toEqual({ organization_id: ORG })
    expect(refused(() => parseListDelegationSubjectsRequest({}))).toMatch(/organization_id/)
  })
})
