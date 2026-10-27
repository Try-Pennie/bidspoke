/**
 * POST /api/connections/:id/replace (#2338, build PR 12; R20, D20).
 *
 * Replace gives each ticked workflow a new version naming the replacement in
 * place of the connection, through writeWorkflow (the write_workflow function,
 * #1947), one save per workflow, from the version it read. Before each write it
 * asks the connection check, as every definition writer does. A save that
 * loses to someone else's (stale_version) is read again and made on top of
 * theirs, so their change is kept; a workflow that no longer names the
 * connection is already done, so running Replace twice writes nothing the
 * second time.
 *
 * The database double keeps the rules that decide these answers: every read is
 * filtered by the caller's organization, connection_references finds a
 * connection in a definition by the predicate's rule (any string value, case
 * and spaces ignored), write_workflow refuses a save from a version that is no
 * longer stored and a definition naming a removed connection (the trigger),
 * and moves the version on each write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../engine/definition-loader')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { refreshWorkflowCaches } from '../../../engine/definition-loader'
import api from '../index'
import { REPLACE_OUTCOMES } from '../../../lib/connection-replace'

const ORG = '0a000000-0000-4000-8000-000000000001'
const OTHER_ORG = '0b000000-0000-4000-8000-000000000002'
const USER = 'aa000000-0000-4000-8000-000000000001'
const COLLEAGUE = 'aa000000-0000-4000-8000-000000000002'

const PENNIE = 'c0000000-0000-4000-8000-000000000001'
const TPL2 = 'c0000000-0000-4000-8000-000000000002'
const THEIRS = 'c0000000-0000-4000-8000-000000000003'
const SNOWFLAKE = 'c0000000-0000-4000-8000-000000000004'
const ALERTS = 'c0000000-0000-4000-8000-000000000005'
const OWN_GOOGLE = 'c0000000-0000-4000-8000-000000000006'
const OTHER_GOOGLE = 'c0000000-0000-4000-8000-000000000007'
const GONE = 'c0000000-0000-4000-8000-000000000008'

const ACHIEVE = '10000000-0000-4000-8000-000000000001'
const CLEANUP = '10000000-0000-4000-8000-000000000002'
const TRIPOINT = '10000000-0000-4000-8000-000000000003'
const OLD_IMPORT = '10000000-0000-4000-8000-000000000004'
const THEIR_FLOW = '10000000-0000-4000-8000-000000000005'

type Row = Record<string, unknown>

function connectionRows(): Row[] {
  return [
    { id: PENNIE, organization_id: ORG, name: 'Pennie Salesforce', service_type: 'salesforce', sealed_for: 'ops_key', person_bound: false, user_id: null },
    { id: TPL2, organization_id: ORG, name: 'TPL2 Salesforce', service_type: 'salesforce', sealed_for: 'ops_key', person_bound: false, user_id: null },
    { id: THEIRS, organization_id: OTHER_ORG, name: 'Their Salesforce', service_type: 'salesforce', sealed_for: 'ops_key', person_bound: false, user_id: null },
    { id: SNOWFLAKE, organization_id: ORG, name: 'Reporting warehouse', service_type: 'snowflake', sealed_for: 'ops_key', person_bound: false, user_id: null },
    { id: ALERTS, organization_id: ORG, name: 'slack', service_type: 'slack', sealed_for: 'bidding_ring', person_bound: false, user_id: null },
    { id: OWN_GOOGLE, organization_id: ORG, name: 'My calendar', service_type: 'google', sealed_for: 'ops_key', person_bound: true, user_id: USER },
    { id: OTHER_GOOGLE, organization_id: ORG, name: 'Dan\'s calendar', service_type: 'google', sealed_for: 'ops_key', person_bound: true, user_id: COLLEAGUE },
  ]
}

/** An ops workflow whose one step runs on the connection named, bound by someone else. */
function definitionOn(connection: string, extra: Row[] = []): Row {
  return {
    nodes: [
      { id: 'n1', namespace: 'trigger', type: 'webhook_trigger', config: {} },
      { id: 'n2', namespace: 'write_lead', type: 'app_action', config: { service: 'salesforce', action: 'salesforce.update-record', connection, boundBy: COLLEAGUE } },
      ...extra,
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
  }
}

function workflowRows(): Row[] {
  return [
    { id: ACHIEVE, organization_id: ORG, name: 'Achieve report import', definition: definitionOn(PENNIE), version: 4, lane: 'ops', is_active: true, definition_schema_version: 1, deleted_at: null },
    { id: CLEANUP, organization_id: ORG, name: 'Daily Salesforce cleanup', definition: definitionOn(PENNIE.toUpperCase()), version: 9, lane: 'ops', is_active: false, definition_schema_version: null, deleted_at: null },
    { id: TRIPOINT, organization_id: ORG, name: 'Tripoint submission', definition: definitionOn(TPL2), version: 2, lane: 'ops', is_active: true, definition_schema_version: 1, deleted_at: null },
    { id: OLD_IMPORT, organization_id: ORG, name: 'Old import', definition: definitionOn(PENNIE), version: 3, lane: 'ops', is_active: false, definition_schema_version: 1, deleted_at: '2026-10-01T00:00:00Z' },
    { id: THEIR_FLOW, organization_id: OTHER_ORG, name: 'Their flow', definition: definitionOn(PENNIE), version: 1, lane: 'ops', is_active: true, definition_schema_version: 1, deleted_at: null },
  ]
}

/** Every string value of a definition, as definition_connection_ids reads it. */
function namedIds(def: unknown): Set<string> {
  const out = new Set<string>()
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.add(v.trim().toLowerCase())
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(def)
  return out
}

type RpcAnswer = { data: unknown; error: { code: string; message: string; details?: string } | null }

interface StoreOptions {
  /** Runs before write_workflow judges a call: a concurrent save landing between the route's read and its write. */
  beforeWrite?: (workflowId: string, rows: Row[]) => void
  rpc?: Partial<Record<string, (args: Record<string, unknown>) => RpcAnswer>>
}

function storeDouble(opts: StoreOptions = {}) {
  const connections = connectionRows()
  const workflows = workflowRows()
  /** Removed connections (tombstones) of ORG. */
  const removed = new Set<string>([GONE])
  const order: string[] = []
  const writes: Array<Record<string, unknown>> = []
  const reads: Array<{ table: string; filters: string[] }> = []

  const from = (table: string) => {
    const source = table === 'service_connections' ? connections : table === 'workflows' ? workflows : null
    if (!source) throw new Error(`the double holds no table ${table}`)
    const filters: Array<(r: Row) => boolean> = []
    const named: string[] = []
    const b = {
      select() { return b },
      eq(col: string, v: unknown) { named.push(`${col}=`); filters.push((r) => r[col] === v); return b },
      in(col: string, vs: unknown[]) { named.push(`${col} in`); filters.push((r) => vs.includes(r[col])); return b },
      is(col: string, v: unknown) { named.push(`${col} is`); filters.push((r) => r[col] === v); return b },
      limit() { return b },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        order.push(`read:${table}`)
        reads.push({ table, filters: named })
        return Promise.resolve({ data: source.filter((r) => filters.every((f) => f(r))).map((r) => structuredClone(r)), error: null }).then(resolve)
      },
      async maybeSingle() {
        order.push(`read:${table}`)
        reads.push({ table, filters: named })
        const found = source.find((r) => filters.every((f) => f(r)))
        return { data: found ? structuredClone(found) : null, error: null }
      },
    }
    return b
  }

  const functions: Record<string, (a: Record<string, unknown>) => RpcAnswer> = {
    connection_references: (a) => {
      const conn = connections.find((r) => r.id === a.p_connection_id && r.organization_id === a.p_organization_id)
      if (!conn) return { data: null, error: { code: 'P0002', message: 'connection_not_found' } }
      const using = workflows
        .filter((w) => w.organization_id === a.p_organization_id && namedIds(w.definition).has(String(a.p_connection_id)))
        .map((w) => ({ workflow_id: w.id, name: w.name, deleted: w.deleted_at !== null }))
      return { data: using, error: null }
    },
    definition_connection_problems: (a) => {
      const problems = [...namedIds(a.p_definition)].filter((id) => removed.has(id)).map((id) => ({ connection_id: id, problem: 'removed', name: null, steps: ['write_lead'] }))
      return { data: problems, error: null }
    },
    write_workflow: (a) => {
      opts.beforeWrite?.(String(a.p_id), workflows)
      writes.push(a)
      const row = workflows.find((w) => w.id === a.p_id && w.organization_id === a.p_org && w.deleted_at === null)
      if (!row) return { data: null, error: { code: 'P0002', message: 'workflow_not_found' } }
      if (a.p_op !== 'save') return { data: null, error: { code: 'BP422', message: 'op_unexpected' } }
      if (row.version !== a.p_expected_version) {
        return { data: null, error: { code: 'BP409', message: 'stale_version', details: JSON.stringify({ current: row, last_save_id: null, changed_by_name: 'Kim', changed_at: '2026-10-27T14:00:00Z' }) } }
      }
      const fields = a.p_fields as Record<string, unknown>
      const missing = [...namedIds(fields.definition)].filter((id) => removed.has(id))
      if (missing.length > 0) {
        return { data: null, error: { code: 'BP409', message: 'workflow_names_missing_connection', details: JSON.stringify(missing.map((id) => ({ id, problem: 'removed', name: null, steps: [] }))) } }
      }
      Object.assign(row, { definition: fields.definition, definition_schema_version: fields.definition_schema_version, version: (row.version as number) + 1 })
      return { data: { workflow: structuredClone(row), version_id: `v-${String(row.id)}-${String(row.version)}`, version_number: row.version }, error: null }
    },
  }

  const rpc = (name: string, args: Record<string, unknown>) => {
    if (name === 'auth_user_with_allowlist') {
      return Promise.resolve({ data: [{ id: USER, organization_id: ORG, email: 'dan@pennie.com', display_name: 'Dan Wright', allowed: true }], error: null })
    }
    order.push(`rpc:${name}`)
    const answer = opts.rpc?.[name] ?? functions[name]
    return Promise.resolve(answer ? answer(args) : { data: null, error: { code: '42883', message: `no function ${name}` } })
  }
  return { from, rpc, connections, workflows, removed, order, writes, reads }
}

const ctx = recordingContext()
const env = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {} } as unknown as Env

async function replace(id: string, body: unknown, headers: Record<string, string> = { Authorization: 'Bearer tok' }) {
  return api.request(`/connections/${id}/replace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }, env, ctx)
}

interface Answer {
  error?: string
  message?: string
  outcome?: string
  workflows?: Array<{ id: string; name: string; outcome: string; version?: number }>
  [k: string]: unknown
}

let db: ReturnType<typeof storeDouble>

function use(store: ReturnType<typeof storeDouble>) {
  db = store
  vi.mocked(createSupabaseClient).mockReturnValue(store as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.mocked(verifyJwt).mockResolvedValue({ sub: USER, email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' })
  vi.mocked(writeAuditLog).mockResolvedValue(undefined)
  vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
  use(storeDouble())
})

afterEach(() => {
  vi.restoreAllMocks()
})

const wf = (id: string) => db.workflows.find((w) => w.id === id)!
const stepOf = (def: unknown) => (def as { nodes: Array<{ namespace: string; config: Record<string, unknown> }> }).nodes.find((n) => n.namespace === 'write_lead')!

describe('who may replace', () => {
  it('a request with no sign in is refused before anything is read', async () => {
    const res = await replace(PENNIE, { with: TPL2, workflows: [ACHIEVE] }, {})
    expect(res.status).toBe(401)
    expect(db.order).toEqual([])
  })
})

describe('Replace gives each ticked workflow a new version naming the replacement', () => {
  it('saves each through write_workflow from the version it read, after the connection check, and answers what it did', async () => {
    const res = await replace(PENNIE, { with: TPL2, workflows: [ACHIEVE, CLEANUP] })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Answer
    expect(body).toMatchObject({
      outcome: 'replaced',
      connection: { id: PENNIE },
      with: { id: TPL2, name: 'TPL2 Salesforce' },
      workflows: [
        { id: ACHIEVE, name: 'Achieve report import', outcome: 'replaced', version: 5 },
        { id: CLEANUP, name: 'Daily Salesforce cleanup', outcome: 'replaced', version: 10 },
      ],
    })
    expect(body.message).toBeUndefined()

    // One save per workflow, each from the version read, each after its own connection check.
    expect(db.writes.map((w) => [w.p_op, w.p_id, w.p_expected_version, w.p_org])).toEqual([['save', ACHIEVE, 4, ORG], ['save', CLEANUP, 9, ORG]])
    const checks = db.order.flatMap((o, i) => (o === 'rpc:definition_connection_problems' ? [i] : []))
    const saves = db.order.flatMap((o, i) => (o === 'rpc:write_workflow' ? [i] : []))
    expect(checks).toHaveLength(2)
    expect(checks[0]).toBeLessThan(saves[0])
    expect(checks[1]).toBeLessThan(saves[1])

    // The step names the replacement (an upper cased id too, as the predicate reads it), bound now by the person who replaced it (#2339).
    for (const id of [ACHIEVE, CLEANUP]) {
      expect(stepOf(wf(id).definition).config.connection).toBe(TPL2)
      expect(stepOf(wf(id).definition).config.boundBy).toBe(USER)
      expect(JSON.stringify(wf(id).definition).toLowerCase()).not.toContain(PENNIE)
    }
    // The version says what changed; the stamp is the row's own, and an unstamped row takes this build's (a save must carry one).
    const fields = db.writes.map((w) => w.p_fields as Record<string, unknown>)
    expect(fields[0]).toMatchObject({ message: 'Replaced Pennie Salesforce with TPL2 Salesforce', definition_schema_version: 1 })
    expect(fields[1]).toMatchObject({ definition_schema_version: 1 })
    expect(Object.keys(fields[0]).sort()).toEqual(['definition', 'definition_report', 'definition_schema_version', 'message'])
    expect(db.writes[0]).toMatchObject({ p_actor: USER, p_actor_email: 'dan@pennie.com' })

    // Both connections and each workflow are read by the caller's organization, never by id alone.
    expect(db.reads.map((r) => r.table)).toEqual(['service_connections', 'workflows', 'workflows'])
    for (const r of db.reads) expect(r.filters).toContain('organization_id=')

    // Each workflow's stored copy is brought up to its new version, and each write is audited under the person.
    expect(vi.mocked(refreshWorkflowCaches).mock.calls.map((c) => c[0])).toEqual([ACHIEVE, CLEANUP])
    expect(vi.mocked(writeAuditLog).mock.calls.map((c) => c.slice(1))).toEqual([
      [ORG, 'workflow', ACHIEVE, 'updated', USER, { replaced_connection: PENNIE, with_connection: TPL2, version: 5 }],
      [ORG, 'workflow', CLEANUP, 'updated', USER, { replaced_connection: PENNIE, with_connection: TPL2, version: 10 }],
    ])
  })

  it('logs one line counting every outcome, each by name, so an outcome added later is counted too', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await replace(PENNIE, { with: TPL2, workflows: [ACHIEVE, OLD_IMPORT] })
    const line = log.mock.calls.map((c) => String(c[0])).find((s) => s.includes('"connection_replaced"'))
    const counted = (JSON.parse(line!) as { outcomes: Record<string, number> }).outcomes
    expect(Object.keys(counted)).toEqual([...REPLACE_OUTCOMES])
    expect(counted).toMatchObject({ replaced: 1, deleted: 1, changed: 0 })
  })

  it('writes only the ticked workflows: one left unticked keeps the old connection', async () => {
    const res = await replace(PENNIE, { with: TPL2, workflows: [CLEANUP] })
    expect(res.status).toBe(200)
    expect(db.writes.map((w) => w.p_id)).toEqual([CLEANUP])
    expect(stepOf(wf(ACHIEVE).definition).config.connection).toBe(PENNIE)
  })

  it('run twice, writes nothing the second time and answers each as already done', async () => {
    await replace(PENNIE, { with: TPL2, workflows: [ACHIEVE, CLEANUP] })
    const writesBefore = db.writes.length
    const res = await replace(PENNIE, { with: TPL2, workflows: [ACHIEVE, CLEANUP] })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ outcome: 'replaced', workflows: [{ id: ACHIEVE, outcome: 'not_using' }, { id: CLEANUP, outcome: 'not_using' }] })
    expect(db.writes.length).toBe(writesBefore)
    expect(wf(ACHIEVE).version).toBe(5)
  })

  it('a refreshed copy that fails is said beside what was written, never instead of it', async () => {
    vi.mocked(refreshWorkflowCaches).mockRejectedValueOnce(new Error('KV down'))
    const res = await replace(PENNIE, { with: TPL2, workflows: [ACHIEVE] })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Answer
    expect(body.outcome).toBe('replaced')
    expect(body.stored_copy_warning).toMatch(/could not be refreshed/)
  })
})

describe('a concurrent edit is never written over', () => {
  it('a save landing between the read and the write: Replace reads again and saves on top of it, keeping their change', async () => {
    let landed = false
    use(storeDouble({
      beforeWrite: (id, rows) => {
        if (landed || id !== ACHIEVE) return
        landed = true
        // Kim saves the canvas: a new step, version 5.
        const row = rows.find((r) => r.id === ACHIEVE)!
        row.definition = definitionOn(PENNIE, [{ id: 'n3', namespace: 'kims_step', type: 'code', config: {} }])
        row.version = 5
      },
    }))
    const res = await replace(PENNIE, { with: TPL2, workflows: [ACHIEVE] })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ outcome: 'replaced', workflows: [{ id: ACHIEVE, outcome: 'replaced', version: 6 }] })
    expect(db.writes.map((w) => w.p_expected_version)).toEqual([4, 5])
    const def = wf(ACHIEVE).definition as { nodes: Array<{ namespace: string }> }
    expect(def.nodes.map((n) => n.namespace)).toContain('kims_step')
    expect(stepOf(def).config.connection).toBe(TPL2)
  })

  it('a concurrent save that took the connection out leaves nothing to do, and nothing is written over it', async () => {
    use(storeDouble({
      beforeWrite: (id, rows) => {
        const row = rows.find((r) => r.id === id)!
        if (row.version !== 4) return
        row.definition = definitionOn(SNOWFLAKE)
        row.version = 5
      },
    }))
    const res = await replace(PENNIE, { with: TPL2, workflows: [ACHIEVE] })
    expect(await res.json()).toMatchObject({ outcome: 'replaced', workflows: [{ id: ACHIEVE, outcome: 'not_using' }] })
    expect(stepOf(wf(ACHIEVE).definition).config.connection).toBe(SNOWFLAKE)
    expect(wf(ACHIEVE).version).toBe(5)
  })

  it('a workflow saved by someone else on every try is left as they saved it, and named', async () => {
    use(storeDouble({
      beforeWrite: (id, rows) => {
        const row = rows.find((r) => r.id === id)!
        row.version = (row.version as number) + 1
      },
    }))
    const res = await replace(PENNIE, { with: TPL2, workflows: [ACHIEVE] })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Answer
    expect(body).toMatchObject({ outcome: 'incomplete', workflows: [{ id: ACHIEVE, outcome: 'changed' }] })
    expect(body.message).toBe('Achieve report import was saved by someone else while this ran, so it still uses Pennie Salesforce. Replace again to move it.')
    expect(db.writes).toHaveLength(3)
    expect(stepOf(wf(ACHIEVE).definition).config.connection).toBe(PENNIE)
    expect(writeAuditLog).not.toHaveBeenCalled()
  })
})

describe('organization scoping', () => {
  it('another organization\'s connection is no such connection, and nothing is read past it', async () => {
    const res = await replace(THEIRS, { with: TPL2, workflows: [ACHIEVE] })
    expect(res.status).toBe(404)
    expect(((await res.json()) as Answer).error).toBe('connection_not_found')
    expect(db.writes).toEqual([])
  })

  it('another organization\'s connection is not one to replace with', async () => {
    const res = await replace(PENNIE, { with: THEIRS, workflows: [ACHIEVE] })
    expect(res.status).toBe(404)
    const body = (await res.json()) as Answer
    expect(body.error).toBe('replace_with_not_found')
    expect(body.message).toMatch(/Nothing was changed/)
    expect(db.writes).toEqual([])
  })

  it('another organization\'s workflow is never read or written, even when ticked', async () => {
    const res = await replace(PENNIE, { with: TPL2, workflows: [THEIR_FLOW] })
    expect(await res.json()).toMatchObject({ outcome: 'replaced', workflows: [{ id: THEIR_FLOW, outcome: 'not_using' }] })
    expect(db.writes).toEqual([])
    expect(stepOf(wf(THEIR_FLOW).definition).config.connection).toBe(PENNIE)
    // Every read of either table is filtered by the caller's organization.
    for (const r of db.reads) expect(r.filters).toContain('organization_id=')
  })

  it('a body naming an organization is refused: the caller\'s own is the only one', async () => {
    const res = await replace(PENNIE, { with: TPL2, workflows: [ACHIEVE], organization_id: OTHER_ORG })
    expect(res.status).toBe(400)
    expect(((await res.json()) as Answer).error).toBe('replace_body_invalid')
    expect(db.order).toEqual([])
  })
})

describe('what may stand in for a connection', () => {
  it('a replacement removed before the request is refused by name, and nothing is written', async () => {
    const res = await replace(PENNIE, { with: GONE, workflows: [ACHIEVE] })
    expect(res.status).toBe(404)
    expect(((await res.json()) as Answer).error).toBe('replace_with_not_found')
    expect(db.writes).toEqual([])
  })

  it('a replacement removed after the check is refused by the store, so the workflow keeps its connection and says why', async () => {
    use(storeDouble({
      // The removal commits between the route's check and its write: the trigger refuses the write.
      beforeWrite: (_id, _rows) => { db.removed.add(TPL2) },
    }))
    const res = await replace(PENNIE, { with: TPL2, workflows: [ACHIEVE] })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Answer
    expect(body).toMatchObject({ outcome: 'incomplete', workflows: [{ id: ACHIEVE, outcome: 'refused' }] })
    expect(body.message).toBe('TPL2 Salesforce was removed while this ran, so Achieve report import still uses Pennie Salesforce. Choose another connection and replace again.')
    expect(stepOf(wf(ACHIEVE).definition).config.connection).toBe(PENNIE)
    expect(writeAuditLog).not.toHaveBeenCalled()
  })

  it.each([
    ['itself', PENNIE, 'replace_with_same'],
    ['a connection of another service', SNOWFLAKE, 'replace_with_other_service'],
    ['the Slack alerts login', ALERTS, 'replace_with_unusable'],
  ])('refuses %s, writing nothing', async (_what, withId, code) => {
    const res = await replace(PENNIE, { with: withId, workflows: [ACHIEVE] })
    expect(res.status).toBe(422)
    const body = (await res.json()) as Answer
    expect(body.error).toBe(code)
    expect(body.message).toMatch(/Nothing was changed/)
    expect(db.writes).toEqual([])
  })

  it('refuses someone else\'s own Google account, which only they may use in a workflow (Dan, 2026-10-23)', async () => {
    const google = storeDouble()
    google.workflows[0].definition = definitionOn(OWN_GOOGLE)
    use(google)
    const res = await replace(OWN_GOOGLE, { with: OTHER_GOOGLE, workflows: [ACHIEVE] })
    expect(res.status).toBe(422)
    expect(((await res.json()) as Answer).error).toBe('replace_with_not_yours')
    expect(db.writes).toEqual([])
  })

  it('takes the replacer\'s own Google account', async () => {
    const google = storeDouble()
    google.workflows[0].definition = definitionOn(OTHER_GOOGLE)
    use(google)
    const res = await replace(OTHER_GOOGLE, { with: OWN_GOOGLE, workflows: [ACHIEVE] })
    expect(await res.json()).toMatchObject({ outcome: 'replaced', workflows: [{ id: ACHIEVE, outcome: 'replaced' }] })
    expect(stepOf(wf(ACHIEVE).definition).config).toMatchObject({ connection: OWN_GOOGLE, boundBy: USER })
  })

  it('the Slack alerts login is never replaced here: no workflow can name it', async () => {
    const res = await replace(ALERTS, { with: TPL2, workflows: [ACHIEVE] })
    expect(res.status).toBe(422)
    expect(((await res.json()) as Answer).error).toBe('connection_not_replaceable')
    expect(db.writes).toEqual([])
  })
})

describe('workflows that cannot get a new version', () => {
  it('a soft deleted workflow is never written, and is named as deleted', async () => {
    const res = await replace(PENNIE, { with: TPL2, workflows: [OLD_IMPORT, ACHIEVE] })
    const body = (await res.json()) as Answer
    expect(body).toMatchObject({ outcome: 'incomplete', workflows: [{ id: OLD_IMPORT, outcome: 'deleted' }, { id: ACHIEVE, outcome: 'replaced' }] })
    expect(body.message).toBe('Old import was deleted, so it cannot get a new version.')
    expect(db.writes.map((w) => w.p_id)).toEqual([ACHIEVE])
  })

  it('a write that fails without saying why is not claimed either way', async () => {
    use(storeDouble({ rpc: { write_workflow: () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }) } }))
    const res = await replace(PENNIE, { with: TPL2, workflows: [ACHIEVE] })
    const body = (await res.json()) as Answer
    expect(body).toMatchObject({ outcome: 'incomplete', workflows: [{ id: ACHIEVE, outcome: 'failed' }] })
    expect(body.message).toMatch(/could not confirm whether Achieve report import got a new version/)
    expect(writeAuditLog).not.toHaveBeenCalled()
  })

  it('a connection check that cannot be made writes nothing and says so', async () => {
    use(storeDouble({ rpc: { definition_connection_problems: () => ({ data: null, error: { code: '57014', message: 'timeout' } }) } }))
    const res = await replace(PENNIE, { with: TPL2, workflows: [ACHIEVE] })
    const body = (await res.json()) as Answer
    expect(body).toMatchObject({ outcome: 'incomplete', workflows: [{ id: ACHIEVE, outcome: 'refused' }] })
    expect(body.message).toMatch(/could not check the connections Achieve report import names/)
    expect(db.writes).toEqual([])
  })

  it('which workflows use the connection cannot be read: nothing is written, 503 by name', async () => {
    use(storeDouble({ rpc: { connection_references: () => ({ data: null, error: { code: '57014', message: 'timeout' } }) } }))
    const res = await replace(PENNIE, { with: TPL2, workflows: [ACHIEVE] })
    expect(res.status).toBe(503)
    expect(((await res.json()) as Answer).error).toBe('replace_uses_unreadable')
    expect(db.writes).toEqual([])
  })
})
