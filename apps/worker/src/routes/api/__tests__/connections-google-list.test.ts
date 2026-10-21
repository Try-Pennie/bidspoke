/**
 * The Google mailboxes and drives list routes (#2338, build PR 6; R10, D10;
 * finding F129): GET, POST and DELETE /api/connections/google/subjects, through
 * OpsConnections' list methods, with the signed in person as the actor ops
 * records on each change. Any signed in user of the organization may add or
 * remove (Dan, 2026-10-18).
 *
 * The ops double keeps the list's rules as add_google_delegation_subject and
 * remove_google_delegation_subject keep them (ops migration 20261020190000,
 * proven in supabase-ops/supabase/tests): a mailbox is trimmed and lower cased,
 * a repeat answers already_listed, a mailbox another organization lists is
 * refused, and a text that is not one address is refused as invalid.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import { rpcStub } from '../../../test-setup/rpc-stub'
import type { Env } from '../../../index'
import {
  parseAddDelegationSubjectRequest, parseListDelegationSubjectsRequest, parseRemoveDelegationSubjectRequest, type DelegationSubjectRow,
} from '../../../lib/ops-connections-contract'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'

const ORG = '0a000000-0000-4000-8000-000000000001'
const OTHER_ORG = '0b000000-0000-4000-8000-000000000002'
const USER = 'aa000000-0000-4000-8000-000000000001'

/** The ops list, as its functions keep it, across organizations. */
function opsList() {
  const entries: Array<DelegationSubjectRow & { organization_id: string }> = [
    { organization_id: ORG, kind: 'mailbox', subject: 'ops@trypennie.com', display_name: null, added_by: 'Dan Wright', added_at: '2026-10-18T15:00:00Z' },
    { organization_id: OTHER_ORG, kind: 'mailbox', subject: 'theirs@lendco.example', display_name: null, added_by: 'Someone', added_at: '2026-10-18T15:00:00Z' },
  ]
  const calls: Array<{ method: string; request: unknown }> = []
  const shown = ({ organization_id: _o, ...row }: DelegationSubjectRow & { organization_id: string }) => row
  const handlers = {
    listDelegationSubjects: async (raw: unknown) => {
      calls.push({ method: 'listDelegationSubjects', request: raw })
      const r = parseListDelegationSubjectsRequest(raw)
      return { ok: true, subjects: entries.filter((e) => e.organization_id === r.organization_id).map(shown), reached_limit: false }
    },
    addDelegationSubject: async (raw: unknown) => {
      calls.push({ method: 'addDelegationSubject', request: raw })
      const r = parseAddDelegationSubjectRequest(raw)
      const subject = r.kind === 'mailbox' ? r.subject.trim().toLowerCase() : r.subject.trim()
      if (r.kind === 'mailbox' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(subject)) return { ok: false, refused: 'delegation_subject_invalid', detail: 'not one mailbox', retry_at: null }
      const held = entries.find((e) => e.kind === r.kind && e.subject === subject)
      if (held && held.organization_id !== r.organization_id) return { ok: false, refused: 'delegation_subject_listed_elsewhere', detail: 'another list', retry_at: null }
      if (held) return { ok: true, outcome: 'already_listed', entry: shown(held) }
      const row = { organization_id: r.organization_id, kind: r.kind, subject, display_name: r.display_name, added_by: r.actor.name ?? r.actor.email ?? '', added_at: '2026-10-20T16:00:00Z' }
      entries.push(row)
      return { ok: true, outcome: 'added', entry: shown(row) }
    },
    removeDelegationSubject: async (raw: unknown) => {
      calls.push({ method: 'removeDelegationSubject', request: raw })
      const r = parseRemoveDelegationSubjectRequest(raw)
      const i = entries.findIndex((e) => e.organization_id === r.organization_id && e.kind === r.kind && e.subject === r.subject.trim().toLowerCase())
      if (i < 0) return { ok: false, refused: 'delegation_subject_not_listed', detail: 'not listed', retry_at: null }
      entries.splice(i, 1)
      return { ok: true, outcome: 'removed' }
    },
  }
  return { entries, calls, handlers }
}

function makeEnv(handlers: Record<string, (r: unknown) => Promise<unknown>>) {
  return { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {}, OPS_CONNECTIONS: rpcStub(handlers) } as unknown as Env
}

const ctx = recordingContext()

async function call(env: Env, method: string, path: string, body?: unknown) {
  const { default: api } = await import('../index')
  return api.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env, ctx)
}

interface Answer { error?: string; message?: string; [k: string]: unknown }

type Row = Record<string, unknown>

/** The bidding connections the removal check reads, by organization, as the table holds them. */
let connectionRows: Row[] = []
let connectionsReadFails = false
const connectionReads: string[] = []

function supabaseDouble() {
  return {
    rpc: (name: string) => Promise.resolve(name === 'auth_user_with_allowlist'
      ? { data: [{ id: USER, organization_id: ORG, email: 'dan@pennie.com', display_name: 'Dan Wright', allowed: true }], error: null }
      : { data: null, error: { code: '42883', message: `no function ${name}` } }),
    from: (table: string) => {
      const filters: Array<(r: Row) => boolean> = []
      const b = {
        select(cols: string) { connectionReads.push(`${table}: ${cols}`); return b },
        eq(col: string, v: unknown) { filters.push((r) => r[col] === v); return b },
        order() { return b },
        async limit(n: number) {
          if (connectionsReadFails) return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
          return { data: connectionRows.filter((r) => filters.every((f) => f(r))).slice(0, n), error: null }
        },
      }
      return b
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  connectionRows = []
  connectionsReadFails = false
  connectionReads.length = 0
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.mocked(verifyJwt).mockResolvedValue({ sub: USER, email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated', user_metadata: { full_name: 'Dan Wright' } })
  vi.mocked(createSupabaseClient).mockReturnValue(supabaseDouble() as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /connections/google/subjects', () => {
  it('lists the caller\'s organization\'s entries alone, asking ops for that organization', async () => {
    const ops = opsList()
    const res = await call(makeEnv(ops.handlers), 'GET', '/connections/google/subjects')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      subjects: [{ kind: 'mailbox', subject: 'ops@trypennie.com', display_name: null, added_by: 'Dan Wright', added_at: '2026-10-18T15:00:00Z' }],
      reached_limit: false,
    })
    expect(ops.calls).toEqual([{ method: 'listDelegationSubjects', request: { organization_id: ORG } }])
  })

  it.each([
    ['ops could not read it', async () => ({ ok: false, refused: 'delegation_list_unavailable', detail: 'x', retry_at: null })],
    ['ops did not answer', async () => { throw new Error('internal error; reference = 0a0b') }],
  ])('a list that cannot be read (%s) is answered by name, never as an empty list (L10)', async (_why, list) => {
    const res = await call(makeEnv({ listDelegationSubjects: list }), 'GET', '/connections/google/subjects')
    expect(res.status).toBe(503)
    const body = (await res.json()) as Answer
    expect(body.error).toBe('delegation_list_unavailable')
    expect(body.subjects).toBeUndefined()
  })
})

describe('POST /connections/google/subjects', () => {
  it('adds a mailbox with the signed in person as the actor ops records', async () => {
    const ops = opsList()
    const res = await call(makeEnv(ops.handlers), 'POST', '/connections/google/subjects', { kind: 'mailbox', subject: ' Reports@TryPennie.com ' })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      outcome: 'added',
      entry: { kind: 'mailbox', subject: 'reports@trypennie.com', display_name: null, added_by: 'Dan Wright', added_at: '2026-10-20T16:00:00Z' },
    })
    expect(parseAddDelegationSubjectRequest(ops.calls[0].request)).toEqual({
      organization_id: ORG, actor: { user_id: USER, email: 'dan@pennie.com', name: 'Dan Wright' }, kind: 'mailbox', subject: ' Reports@TryPennie.com ', display_name: null,
    })
  })

  it('a repeat is answered already_listed, and adds nothing', async () => {
    const ops = opsList()
    const res = await call(makeEnv(ops.handlers), 'POST', '/connections/google/subjects', { kind: 'mailbox', subject: 'OPS@trypennie.com' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ outcome: 'already_listed', entry: { subject: 'ops@trypennie.com', added_by: 'Dan Wright' } })
    expect(ops.entries.filter((e) => e.organization_id === ORG)).toHaveLength(1)
  })

  it('a malformed address is refused by name, with its sentence, and nothing is added', async () => {
    const ops = opsList()
    const res = await call(makeEnv(ops.handlers), 'POST', '/connections/google/subjects', { kind: 'mailbox', subject: 'ops at trypennie' })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({
      error: 'delegation_subject_invalid',
      message: 'ops at trypennie is not one mailbox address or one shared drive id. Nothing was added. Check it and add it again.',
    })
    expect(ops.entries).toHaveLength(2)
  })

  it('an empty or overlong entry is refused before it crosses to ops', async () => {
    const ops = opsList()
    for (const subject of ['   ', `${'a'.repeat(320)}@x.example`]) {
      const res = await call(makeEnv(ops.handlers), 'POST', '/connections/google/subjects', { kind: 'mailbox', subject })
      expect(res.status).toBe(422)
      expect(((await res.json()) as Answer).error).toBe('delegation_subject_invalid')
    }
    expect(ops.calls).toEqual([])
  })

  it('a mailbox another organization lists is refused, and never shown', async () => {
    const ops = opsList()
    const res = await call(makeEnv(ops.handlers), 'POST', '/connections/google/subjects', { kind: 'mailbox', subject: 'theirs@lendco.example' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as Answer
    expect(body.error).toBe('delegation_subject_listed_elsewhere')
    expect(JSON.stringify(body)).not.toContain('Someone')
  })

  it('a body naming an organization, or a kind that is neither mailbox nor drive, is refused before ops is asked', async () => {
    const ops = opsList()
    for (const body of [
      { kind: 'mailbox', subject: 'new@trypennie.com', organization_id: OTHER_ORG },
      { kind: 'calendar', subject: 'new@trypennie.com' },
    ]) {
      const res = await call(makeEnv(ops.handlers), 'POST', '/connections/google/subjects', body)
      expect(res.status).toBe(400)
      expect(((await res.json()) as Answer).error).toBe('connection_request_invalid')
    }
    expect(ops.calls).toEqual([])
  })

  it('a change ops did not confirm is said to be unconfirmed, never done', async () => {
    const res = await call(makeEnv({ addDelegationSubject: () => new Promise((_r, reject) => reject(new Error('internal error; reference = 0a0b'))) }), 'POST', '/connections/google/subjects', { kind: 'mailbox', subject: 'new@trypennie.com' })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'delegation_change_failed', message: 'Bidspoke could not confirm the change to the list. Reload the list to see whether it was made.' })
  })
})

describe('DELETE /connections/google/subjects/:kind/:subject', () => {
  it('removes an entry of the caller\'s organization, as the signed in person', async () => {
    const ops = opsList()
    const res = await call(makeEnv(ops.handlers), 'DELETE', `/connections/google/subjects/mailbox/${encodeURIComponent('ops@trypennie.com')}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'removed' })
    expect(parseRemoveDelegationSubjectRequest(ops.calls[0].request)).toEqual({
      organization_id: ORG, actor: { user_id: USER, email: 'dan@pennie.com', name: 'Dan Wright' }, kind: 'mailbox', subject: 'ops@trypennie.com',
    })
    expect(ops.entries.some((e) => e.subject === 'ops@trypennie.com')).toBe(false)
  })

  it('another organization\'s entry is not on this list, and is left alone', async () => {
    const ops = opsList()
    const res = await call(makeEnv(ops.handlers), 'DELETE', `/connections/google/subjects/mailbox/${encodeURIComponent('theirs@lendco.example')}`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as Answer).error).toBe('delegation_subject_not_listed')
    expect(ops.entries.some((e) => e.subject === 'theirs@lendco.example')).toBe(true)
  })
})

describe('removing an entry a saved connection names is refused, naming each such connection (Dan, 2026-10-20)', () => {
  const ops = () => opsList()
  const del = (env: Env, kind: string, subject: string) => call(env, 'DELETE', `/connections/google/subjects/${kind}/${encodeURIComponent(subject)}`)

  it('a mailbox a connection acts as: 409 naming the connection, and ops is asked nothing', async () => {
    connectionRows = [
      { id: 'c1', organization_id: ORG, name: 'Ops mailbox', service_type: 'google', target: { subject: ' OPS@trypennie.com ' } },
      { id: 'c2', organization_id: ORG, name: 'Reports drive', service_type: 'google', target: { subject: 'reports@trypennie.com', drives: ['0AbCdEf'] } },
    ]
    const o = ops()
    const res = await del(makeEnv(o.handlers), 'mailbox', 'ops@trypennie.com')
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'delegation_subject_in_use',
      message: 'Ops mailbox acts as ops@trypennie.com, so it cannot be taken off the list. Nothing was removed. Remove that connection first.',
      connections: [{ id: 'c1', name: 'Ops mailbox', service: 'google' }],
    })
    expect(o.calls).toEqual([])
    expect(o.entries.some((e) => e.subject === 'ops@trypennie.com')).toBe(true)
  })

  it('a shared drive a connection names, by its id, names every such connection', async () => {
    connectionRows = [
      { id: 'c2', organization_id: ORG, name: 'Reports drive', service_type: 'google', target: { subject: 'reports@trypennie.com', drives: ['0AbCdEf'] } },
      { id: 'c3', organization_id: ORG, name: 'Partner drive', service_type: 'google', target: { subject: 'ops@trypennie.com', drives: '0AbCdEf' } },
    ]
    const res = await del(makeEnv(ops().handlers), 'drive', '0AbCdEf')
    expect(res.status).toBe(409)
    const body = (await res.json()) as Answer
    expect(body.connections).toEqual([{ id: 'c3', name: 'Partner drive', service: 'google' }, { id: 'c2', name: 'Reports drive', service: 'google' }])
    expect(body.message).toBe('Partner drive and Reports drive act as 0AbCdEf, so it cannot be taken off the list. Nothing was removed. Remove those connections first.')
  })

  it('is allowed once no connection names it: another mailbox, another kind, or another organization\'s connection', async () => {
    connectionRows = [
      { id: 'c2', organization_id: ORG, name: 'Reports drive', service_type: 'google', target: { subject: 'reports@trypennie.com', drives: ['ops@trypennie.com'] } },
      { id: 'c9', organization_id: OTHER_ORG, name: 'Their mailbox', service_type: 'google', target: { subject: 'ops@trypennie.com' } },
      { id: 'c5', organization_id: ORG, name: 'slack', service_type: 'slack', target: null },
    ]
    const o = ops()
    const res = await del(makeEnv(o.handlers), 'mailbox', 'ops@trypennie.com')
    expect(res.status).toBe(200)
    expect(o.calls.map((c) => c.method)).toEqual(['removeDelegationSubject'])
    // Only names and targets are read, never a login.
    expect(connectionReads.every((r) => !/credential_enc|config/.test(r))).toBe(true)
  })

  it('when the connections cannot be read, nothing is removed: never a pass', async () => {
    connectionsReadFails = true
    const o = ops()
    const res = await del(makeEnv(o.handlers), 'mailbox', 'ops@trypennie.com')
    expect(res.status).toBe(503)
    expect(((await res.json()) as Answer).error).toBe('delegation_use_unreadable')
    expect(o.calls).toEqual([])
  })
})
