/**
 * The current variables of the ops runs the tick claims (#2997, phase 1 of
 * #2982; Dan's decisions of 2026-10-28 and 2026-10-29: an ops run reads each
 * variable's current value at its start, and "Yes, ops reads secrets").
 *
 * The ops tick names runs by workflow and version only. The bidding Worker
 * reads each version it holds, derives the names the definition reads itself
 * (envReferences), resolves them over the organization's current rows with the
 * one resolver, and decrypts each secret one. These tests prove: nothing the
 * definition does not read is ever served; a secret's ciphertext never leaves;
 * each refusal is named and refuses only its own run; a failed read throws
 * rather than serving an empty set; and the ops Worker cannot call the method
 * before the bidding deploy carries it.
 */
import { createClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_RUN_VARIABLES_PER_REQUEST, OPS_GATEWAY_METHODS, OPS_GATEWAY_SERVED_AHEAD, OpsGatewayContractError, RUN_VARIABLES_REFUSALS,
  parseOpsRunVariablesRequest, parseServedOpsRunVariableNames, parseServedOpsRunVariables,
} from '../ops-gateway-contract'
import { readOpsRunVariableNames, readOpsRunVariables } from '../ops-gateway'
import { decryptSecret, encryptSecret } from '../secret-crypto'

// Every decrypt is watched (#3034): the names mode must never call it. The real one still runs, so the decrypting tests below are unchanged.
vi.mock('../secret-crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('../secret-crypto')>()
  return { ...real, decryptSecret: vi.fn(real.decryptSecret) }
})
import { TICK_CLAIM_LIMIT } from '../../ops/tick'

const KEY = btoa('0'.repeat(32))
const WRONG_KEY = btoa('1'.repeat(32))
const NOW = Date.parse('2026-10-29T13:00:00.000Z')
const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const OTHER_ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f61'
const WF = '00000000-0000-4000-8000-0000000029a1'
const WF2 = '00000000-0000-4000-8000-0000000029a2'
const MONEY_WF = '00000000-0000-4000-8000-0000000029a3'
const DELETED_WF = '00000000-0000-4000-8000-0000000029a4'
const THEIR_WF = '00000000-0000-4000-8000-0000000029a5'
const GONE_WF = '00000000-0000-4000-8000-0000000029a6'

/** A definition whose one step reads each name, as a template. */
const reads = (...keys: string[]) => ({
  trigger: { type: 'schedule', config: {} },
  nodes: [{ id: 'a', namespace: 'a', type: 'transform', config: { mappings: keys.map((k) => ({ source: `{{env.${k}}}`, target: k.toLowerCase() })) } }],
  edges: [],
})

interface WorkflowRow { id: string; organization_id: string; lane: string; deleted_at: string | null }
interface VersionRow { workflow_id: string; version_number: number; definition: unknown }
interface EnvRow { id: string; organization_id: string; key: string; value: string | null; is_secret: boolean; scope: string; workflow_id: string | null; created_at: string }

const wf = (id: string, over: Partial<WorkflowRow> = {}): WorkflowRow => ({ id, organization_id: ORG, lane: 'ops', deleted_at: null, ...over })
let envSeq = 0
const env = (key: string, value: string | null, over: Partial<EnvRow> = {}): EnvRow => ({
  id: `00000000-0000-4000-9000-${String(++envSeq).padStart(12, '0')}`, organization_id: ORG, key, value, is_secret: false, scope: 'global', workflow_id: null,
  created_at: `2026-10-29T00:00:${String(envSeq % 60).padStart(2, '0')}Z`, ...over,
})

/**
 * PostgREST for the three tables, each answered from the rows given and
 * filtered the way the query asks (only the filters the reader uses), every
 * query recorded. `fail` names a table whose read answers an error.
 */
function db(opts: { workflows: WorkflowRow[]; versions: VersionRow[]; env: EnvRow[]; fail?: string; ignoreOrgFilter?: boolean }) {
  const queries: URL[] = []
  const fakeFetch: typeof globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    queries.push(url)
    const table = url.pathname.replace('/rest/v1/', '')
    if (opts.fail === table) return Response.json({ code: 'PGRST000', message: 'the database is not answering' }, { status: 503 })
    const inList = (param: string | null) => (param ?? '').replace(/^in\.\(/, '').replace(/\)$/, '').split(',').map((s) => s.replace(/^"|"$/g, ''))
    if (table === 'workflows') return Response.json(opts.workflows.filter((w) => inList(url.searchParams.get('id')).includes(w.id)))
    if (table === 'workflow_versions') {
      return Response.json(opts.versions.filter((v) => url.searchParams.get('workflow_id') === `eq.${v.workflow_id}` && url.searchParams.get('version_number') === `eq.${v.version_number}`))
    }
    if (table === 'environment_variables') {
      // The organization filter is honoured only when asked, so a reader that forgets it is seen serving another's row.
      const orgFilter = opts.ignoreOrgFilter ? null : url.searchParams.get('organization_id')
      const keys = inList(url.searchParams.get('key'))
      return Response.json(opts.env.filter((r) => (orgFilter === null || orgFilter === `eq.${r.organization_id}`) && keys.includes(r.key)))
    }
    return Response.json([])
  }) as typeof globalThis.fetch
  return { client: createClient('https://xvrmivmpfykwwtriqwpg.supabase.co', 'sb_secret_test', { global: { fetch: fakeFetch }, auth: { persistSession: false }, db: { retry: false } } as never), queries, fetch: fakeFetch }
}

const run = (workflow_id: string, version_number = 3) => ({ workflow_id, version_number })
const ask = (...runs: Array<{ workflow_id: string; version_number: number }>) => ({ organization_id: ORG, runs })

describe('the request the ops tick sends', () => {
  it('reads an organization and its runs, each a workflow and a version, at most MAX_RUN_VARIABLES_PER_REQUEST', () => {
    expect(parseOpsRunVariablesRequest(ask(run(WF)))).toEqual(ask(run(WF)))
    expect(parseOpsRunVariablesRequest(ask())).toEqual(ask())
    const many = Array.from({ length: MAX_RUN_VARIABLES_PER_REQUEST + 1 }, (_, i) => run(WF, i + 1))
    expect(() => parseOpsRunVariablesRequest(ask(...many))).toThrow(OpsGatewayContractError)
  })

  it('holds a whole tick\'s claim, so one request per organization per tick is enough', () => {
    expect(MAX_RUN_VARIABLES_PER_REQUEST).toBeGreaterThanOrEqual(TICK_CLAIM_LIMIT)
  })

  it('refuses anything else by name, before any read, including any way of naming a variable', () => {
    for (const bad of [
      null, [], 'x', { runs: [] }, { organization_id: 'nope', runs: [] }, { organization_id: ORG }, { organization_id: ORG, runs: 'all' },
      { organization_id: ORG, runs: [], names: ['TOKEN'] },
      { organization_id: ORG, runs: [{ workflow_id: WF, version_number: 3, names: ['TOKEN'] }] },
      { organization_id: ORG, runs: [{ workflow_id: WF, version_number: 3, keys: ['TOKEN'] }] },
      { organization_id: ORG, runs: [{ workflow_id: 'nope', version_number: 3 }] },
      { organization_id: ORG, runs: [{ workflow_id: WF, version_number: 0 }] },
      { organization_id: ORG, runs: [{ workflow_id: WF, version_number: 2.5 }] },
      { organization_id: ORG, runs: [run(WF), run(WF)] },
    ]) {
      expect(() => parseOpsRunVariablesRequest(bad), JSON.stringify(bad)).toThrow(OpsGatewayContractError)
    }
  })
})

describe('readOpsRunVariables (the bidding Worker)', () => {
  it('serves the current plain values the definition reads, resolved by the one resolver, with when they were read', async () => {
    const { client, queries } = db({
      workflows: [wf(WF)],
      versions: [{ workflow_id: WF, version_number: 3, definition: reads('API_BASE', 'LIST_ID') }],
      env: [env('API_BASE', 'org base'), env('API_BASE', 'workflow base', { scope: 'workflow', workflow_id: WF }), env('LIST_ID', 'older'), env('LIST_ID', 'newer')],
    })
    const answer = await readOpsRunVariables(client, KEY, ask(run(WF)), NOW)
    expect(answer).toEqual({
      organization_id: ORG,
      runs: [{ workflow_id: WF, version_number: 3, values: { API_BASE: 'workflow base', LIST_ID: 'newer' }, secret_values: {}, served_at: new Date(NOW).toISOString() }],
    })
    const envQuery = queries.find((q) => q.pathname === '/rest/v1/environment_variables') as URL
    expect(envQuery.searchParams.get('organization_id')).toBe(`eq.${ORG}`)
    // The later saved wins, so the read is in saved order, with a unique key last so no row is skipped between pages.
    expect(envQuery.searchParams.get('order')).toBe('created_at.asc,id.asc')
  })

  it('never serves a variable the definition does not read, whatever rows exist', async () => {
    const { client, queries } = db({
      workflows: [wf(WF)],
      versions: [{ workflow_id: WF, version_number: 3, definition: reads('API_BASE') }],
      env: [env('API_BASE', 'base'), env('UNREAD', 'not read'), env('UNREAD_SECRET', await encryptSecret('unread secret', KEY), { is_secret: true })],
    })
    const answer = await readOpsRunVariables(client, KEY, ask(run(WF)), NOW)
    expect(answer.runs[0]).toMatchObject({ values: { API_BASE: 'base' }, secret_values: {} })
    expect(JSON.stringify(answer)).not.toMatch(/UNREAD|not read|unread secret/)
    // And the read itself asks only for the names the definition reads.
    const envQuery = queries.find((q) => q.pathname === '/rest/v1/environment_variables') as URL
    expect(envQuery.searchParams.get('key')).toBe('in.(API_BASE)')
  })

  it('decrypts each secret the definition reads under secret_values, and the ciphertext never leaves', async () => {
    const ciphertext = await encryptSecret('the planted plaintext', KEY)
    const ownCiphertext = await encryptSecret('the workflow\'s own plaintext', KEY)
    const { client } = db({
      workflows: [wf(WF)],
      versions: [{ workflow_id: WF, version_number: 3, definition: reads('TOKEN', 'OWN_TOKEN', 'API_BASE') }],
      env: [
        env('TOKEN', ciphertext, { is_secret: true }), env('API_BASE', 'base'),
        env('OWN_TOKEN', 'org plain'), env('OWN_TOKEN', ownCiphertext, { is_secret: true, scope: 'workflow', workflow_id: WF }),
      ],
    })
    const answer = await readOpsRunVariables(client, KEY, ask(run(WF)), NOW)
    expect(answer.runs[0]).toMatchObject({
      values: { API_BASE: 'base' }, secret_values: { TOKEN: 'the planted plaintext', OWN_TOKEN: 'the workflow\'s own plaintext' },
    })
    const serialized = JSON.stringify(answer)
    expect(serialized).not.toContain(ciphertext)
    expect(serialized).not.toContain(ownCiphertext)
    expect(serialized).toContain('the planted plaintext')
  })

  it('decrypts through the key ring, so a secret re-locked with the next key during a rotation is still served', async () => {
    const relocked = await encryptSecret('re-locked', WRONG_KEY)
    const { client } = db({ workflows: [wf(WF)], versions: [{ workflow_id: WF, version_number: 3, definition: reads('TOKEN') }], env: [env('TOKEN', relocked, { is_secret: true })] })
    const answer = await readOpsRunVariables(client, { encryptWith: WRONG_KEY, decryptWith: [WRONG_KEY, KEY] }, ask(run(WF)), NOW)
    expect(answer.runs[0]).toMatchObject({ secret_values: { TOKEN: 're-locked' } })
  })

  it('refuses, naming them, a run whose secret will not decrypt, never serving it blank, while the run beside it is served', async () => {
    const unreadable = await encryptSecret('locked with a key this Worker lacks', WRONG_KEY)
    const { client } = db({
      workflows: [wf(WF), wf(WF2)],
      versions: [
        { workflow_id: WF, version_number: 3, definition: reads('TOKEN', 'API_BASE') },
        { workflow_id: WF2, version_number: 1, definition: reads('API_BASE') },
      ],
      env: [env('TOKEN', unreadable, { is_secret: true }), env('API_BASE', 'base')],
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const answer = await readOpsRunVariables(client, KEY, ask(run(WF), run(WF2, 1)), NOW)
      expect(answer.runs).toEqual([
        { workflow_id: WF, version_number: 3, refused: 'secret_unreadable', keys: ['TOKEN'] },
        { workflow_id: WF2, version_number: 1, values: { API_BASE: 'base' }, secret_values: {}, served_at: new Date(NOW).toISOString() },
      ])
      expect(JSON.stringify(answer)).not.toContain(unreadable)
      // Logged by name, never by value.
      const logged = error.mock.calls.flat().join('\n')
      expect(logged).toMatch(/TOKEN/)
      expect(logged).not.toContain(unreadable)
    } finally {
      error.mockRestore()
    }
  })

  it('leaves out a variable the definition reads that has no row, so ops names it missing', async () => {
    const { client } = db({ workflows: [wf(WF)], versions: [{ workflow_id: WF, version_number: 3, definition: reads('API_BASE', 'NOT_SAVED') }], env: [env('API_BASE', 'base'), env('NOT_SAVED', '')] })
    const answer = await readOpsRunVariables(client, KEY, ask(run(WF)), NOW)
    expect(answer.runs[0]).toEqual({ workflow_id: WF, version_number: 3, values: { API_BASE: 'base' }, secret_values: {}, served_at: new Date(NOW).toISOString() })
  })

  it('never serves a row of another organization, even when the database answers one', async () => {
    const { client } = db({ workflows: [wf(WF)], versions: [{ workflow_id: WF, version_number: 3, definition: reads('API_BASE') }], env: [env('API_BASE', 'theirs', { organization_id: OTHER_ORG })], ignoreOrgFilter: true })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const answer = await readOpsRunVariables(client, KEY, ask(run(WF)), NOW)
      expect(answer.runs[0]).toEqual({ workflow_id: WF, version_number: 3, values: {}, secret_values: {}, served_at: new Date(NOW).toISOString() })
    } finally {
      error.mockRestore()
    }
  })

  it('refuses each run it will not serve by its own reason, and serves the good one beside them', async () => {
    const { client, queries } = db({
      workflows: [wf(WF), wf(WF2), wf(MONEY_WF, { lane: 'money' }),wf(DELETED_WF, { deleted_at: '2026-10-28T00:00:00Z' }), wf(THEIR_WF, { organization_id: OTHER_ORG })],
      versions: [
        { workflow_id: WF, version_number: 3, definition: reads('API_BASE') },
        { workflow_id: MONEY_WF, version_number: 3, definition: reads('API_BASE') },
        { workflow_id: DELETED_WF, version_number: 3, definition: reads('API_BASE') },
        { workflow_id: THEIR_WF, version_number: 3, definition: reads('API_BASE') },
        { workflow_id: WF2, version_number: 2, definition: 'not an object' },
      ],
      env: [env('API_BASE', 'base')],
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let answer: Awaited<ReturnType<typeof readOpsRunVariables>>
    try {
      answer = await readOpsRunVariables(client, KEY, ask(run(MONEY_WF), run(DELETED_WF), run(THEIR_WF), run(GONE_WF), run(WF, 9), run(WF2, 2), run(WF)), NOW)
    } finally {
      error.mockRestore()
    }
    expect(answer.runs).toEqual([
      { workflow_id: MONEY_WF, version_number: 3, refused: 'not_ops_lane', keys: [] },
      { workflow_id: DELETED_WF, version_number: 3, refused: 'workflow_deleted', keys: [] },
      { workflow_id: THEIR_WF, version_number: 3, refused: 'other_organization', keys: [] },
      { workflow_id: GONE_WF, version_number: 3, refused: 'version_missing', keys: [] },
      { workflow_id: WF, version_number: 9, refused: 'version_missing', keys: [] },
      { workflow_id: WF2, version_number: 2, refused: 'version_unreadable', keys: [] },
      { workflow_id: WF, version_number: 3, values: { API_BASE: 'base' }, secret_values: {}, served_at: new Date(NOW).toISOString() },
    ])
    // A refused workflow's version is never read: neither a money lane definition nor another organization's.
    const versionReads = queries.filter((q) => q.pathname === '/rest/v1/workflow_versions').map((q) => q.searchParams.get('workflow_id'))
    expect(versionReads).not.toContain(`eq.${MONEY_WF}`)
    expect(versionReads).not.toContain(`eq.${THEIR_WF}`)
    expect(versionReads).not.toContain(`eq.${DELETED_WF}`)
  })

  it('reads nothing for an empty request, and reads no variables for runs that read none', async () => {
    const empty = db({ workflows: [], versions: [], env: [] })
    expect(await readOpsRunVariables(empty.client, KEY, ask(), NOW)).toEqual({ organization_id: ORG, runs: [] })
    expect(empty.queries).toEqual([])
    const none = db({ workflows: [wf(WF)], versions: [{ workflow_id: WF, version_number: 3, definition: reads() }], env: [env('API_BASE', 'base')] })
    expect((await readOpsRunVariables(none.client, KEY, ask(run(WF)), NOW)).runs[0]).toEqual({ workflow_id: WF, version_number: 3, values: {}, secret_values: {}, served_at: new Date(NOW).toISOString() })
    expect(none.queries.some((q) => q.pathname === '/rest/v1/environment_variables')).toBe(false)
  })

  it.each(['workflows', 'workflow_versions', 'environment_variables'])('throws when the %s read fails, never answering an empty set', async (table) => {
    const { client } = db({ workflows: [wf(WF)], versions: [{ workflow_id: WF, version_number: 3, definition: reads('API_BASE') }], env: [env('API_BASE', 'base')], fail: table })
    await expect(readOpsRunVariables(client, KEY, ask(run(WF)), NOW)).rejects.toThrow()
  })
})

describe('the answer, as the ops Worker reads it', () => {
  const asked = ask(run(WF), run(WF2, 1))
  const served = { workflow_id: WF, version_number: 3, values: { API_BASE: 'base' }, secret_values: { TOKEN: 't' }, served_at: '2026-10-29T13:00:00.000Z' }
  const refused = { workflow_id: WF2, version_number: 1, refused: 'secret_unreadable', keys: ['TOKEN'] }

  it('reads each run served or refused', () => {
    expect(parseServedOpsRunVariables({ organization_id: ORG, runs: [served, refused] }, asked)).toEqual({
      runs: [
        { kind: 'served', workflowId: WF, versionNumber: 3, values: { API_BASE: 'base' }, secretValues: { TOKEN: 't' }, servedAt: '2026-10-29T13:00:00.000Z' },
        { kind: 'refused', workflowId: WF2, versionNumber: 1, reason: 'secret_unreadable', keys: ['TOKEN'] },
      ],
      unreadable: [],
    })
  })

  it('names every refusal reason the bidding Worker can give', () => {
    expect([...RUN_VARIABLES_REFUSALS].sort()).toEqual(['not_ops_lane', 'other_organization', 'secret_unreadable', 'version_missing', 'version_unreadable', 'workflow_deleted'])
  })

  it('throws on an answer that is not the shape at all, or is another organization\'s', () => {
    for (const bad of [null, [], { runs: [] }, { organization_id: ORG }, { organization_id: ORG, runs: {} }, { organization_id: OTHER_ORG, runs: [served] }]) {
      expect(() => parseServedOpsRunVariables(bad, asked), JSON.stringify(bad)).toThrow(OpsGatewayContractError)
    }
  })

  it('names, without failing the rest, a run it cannot read, did not ask for, or was not answered', () => {
    const bads = [
      { ...served, values: { API_BASE: 5 } },
      { ...served, values: { 'bad key': 'v' } },
      { ...served, secret_values: { API_BASE: 'twice' } },
      { ...served, served_at: 'yesterday' },
      { ...served, extra: true },
      { ...refused, refused: 'tired' },
      { ...refused, keys: 'TOKEN' },
      { workflow_id: WF, version_number: 4, values: {}, secret_values: {}, served_at: '2026-10-29T13:00:00.000Z' },
    ]
    for (const bad of bads) {
      const read = parseServedOpsRunVariables({ organization_id: ORG, runs: [bad, refused] }, asked)
      expect(read.runs, JSON.stringify(bad)).toEqual([{ kind: 'refused', workflowId: WF2, versionNumber: 1, reason: 'secret_unreadable', keys: ['TOKEN'] }])
      // The bad row, and the asked run it leaves unanswered.
      expect(read.unreadable.length, JSON.stringify(bad)).toBeGreaterThanOrEqual(1)
      expect(read.unreadable.join('\n')).toContain(WF)
    }
  })

  it('never lets a secret value into the text naming an unreadable run', () => {
    const read = parseServedOpsRunVariables({ organization_id: ORG, runs: [{ ...served, secret_values: { TOKEN: 'do not echo me', API_BASE: 'x' } }] }, asked)
    expect(read.unreadable.join('\n')).not.toContain('do not echo me')
  })
})

describe('the gate: ops calls opsRunVariables once the bidding deploy carries it', () => {
  it('the entrypoint serves exactly the methods ops calls and the ones served ahead of it', async () => {
    const { OpsGateway } = await import('../ops-gateway-entrypoint')
    const names = Object.getOwnPropertyNames(OpsGateway.prototype).filter((n) => n !== 'constructor').sort()
    expect(names).toEqual([...OPS_GATEWAY_METHODS, ...OPS_GATEWAY_SERVED_AHEAD].sort())
    // #2998 (phase 2) moved it onto the binding, once #3008's bidding deploy carried it.
    expect(OPS_GATEWAY_SERVED_AHEAD).toEqual([])
    expect(OPS_GATEWAY_METHODS as readonly string[]).toContain('opsRunVariables')
  })

  // No ops Worker source names a method served ahead: the web guard
  // __guards__/worker/ops-gateway-served-ahead.test.ts, which can read files.

  it('the entrypoint reads the request by name before any read', async () => {
    const { OpsGateway } = await import('../ops-gateway-entrypoint')
    const gw = new OpsGateway({} as ExecutionContext, { SECRET_ENCRYPTION_KEY: KEY } as never)
    await expect((async () => gw.opsRunVariables({ organization_id: ORG, runs: [], names: ['TOKEN'] }))()).rejects.toThrow(OpsGatewayContractError)
  })
})

describe('the names mode, for the ops copy refresh (#3034)', () => {
  const names = (...runs: Array<{ workflow_id: string; version_number: number }>) => ({ organization_id: ORG, runs, secrets: 'names' as const })
  // Braced: a function returned from beforeEach is run as its teardown, and mockClear returns the mock itself.
  beforeEach(() => {
    vi.mocked(decryptSecret).mockClear()
  })

  it('the request may ask for names, and for nothing else beside the runs', () => {
    expect(parseOpsRunVariablesRequest(names(run(WF)))).toEqual(names(run(WF)))
    for (const bad of [
      { ...ask(run(WF)), secrets: 'values' }, { ...ask(run(WF)), secrets: true }, { ...ask(run(WF)), secrets: null }, { ...ask(run(WF)), secrets: ['TOKEN'] },
      { ...names(run(WF)), names: ['TOKEN'] },
    ]) {
      expect(() => parseOpsRunVariablesRequest(bad), JSON.stringify(bad)).toThrow(OpsGatewayContractError)
    }
  })

  it('serves each plain value and each secret by NAME only, and never calls the decrypt', async () => {
    const ciphertext = await encryptSecret('fake names mode plaintext', KEY)
    const unreadable = await encryptSecret('fake locked with another key', WRONG_KEY)
    const { client } = db({
      workflows: [wf(WF)],
      versions: [{ workflow_id: WF, version_number: 3, definition: reads('TOKEN', 'LOCKED', 'API_BASE', 'NOT_SAVED') }],
      env: [env('TOKEN', ciphertext, { is_secret: true }), env('LOCKED', unreadable, { is_secret: true }), env('API_BASE', 'base')],
    })
    // The control (L1): the decrypting mode is seen calling it, so a zero below is a measurement.
    await readOpsRunVariables(client, KEY, ask(run(WF)), NOW)
    expect(vi.mocked(decryptSecret)).toHaveBeenCalled()
    vi.mocked(decryptSecret).mockClear()

    const answer = await readOpsRunVariableNames(client, names(run(WF)), NOW)
    expect(vi.mocked(decryptSecret)).not.toHaveBeenCalled()
    // A secret that would not decrypt cannot be told here, so it is served by name like any other.
    expect(answer).toEqual({
      organization_id: ORG,
      runs: [{ workflow_id: WF, version_number: 3, values: { API_BASE: 'base' }, secret_keys: ['TOKEN', 'LOCKED'], served_at: new Date(NOW).toISOString() }],
    })
    const serialized = JSON.stringify(answer)
    for (const never of [ciphertext, unreadable, 'fake names mode plaintext', 'secret_values']) expect(serialized).not.toContain(never)
  })

  it('refuses each run by the same reasons, and never a secret as unreadable', async () => {
    const { client } = db({
      workflows: [wf(WF), wf(MONEY_WF, { lane: 'money' }), wf(THEIR_WF, { organization_id: OTHER_ORG })],
      versions: [{ workflow_id: WF, version_number: 3, definition: reads('API_BASE') }, { workflow_id: MONEY_WF, version_number: 3, definition: reads('API_BASE') }],
      env: [env('API_BASE', 'base')],
    })
    const answer = await readOpsRunVariableNames(client, names(run(MONEY_WF), run(THEIR_WF), run(GONE_WF), run(WF)), NOW)
    expect(answer.runs).toEqual([
      { workflow_id: MONEY_WF, version_number: 3, refused: 'not_ops_lane', keys: [] },
      { workflow_id: THEIR_WF, version_number: 3, refused: 'other_organization', keys: [] },
      { workflow_id: GONE_WF, version_number: 3, refused: 'version_missing', keys: [] },
      { workflow_id: WF, version_number: 3, values: { API_BASE: 'base' }, secret_keys: [], served_at: new Date(NOW).toISOString() },
    ])
  })

  it('the entrypoint sends a names request to the names reader, and nothing on that path decrypts', async () => {
    const ciphertext = await encryptSecret('fake entrypoint plaintext', KEY)
    const { fetch } = db({ workflows: [wf(WF)], versions: [{ workflow_id: WF, version_number: 3, definition: reads('TOKEN') }], env: [env('TOKEN', ciphertext, { is_secret: true })] })
    const { OpsGateway } = await import('../ops-gateway-entrypoint')
    const gw = new OpsGateway({} as ExecutionContext, { SUPABASE_URL: 'https://xvrmivmpfykwwtriqwpg.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test', SECRET_ENCRYPTION_KEY: KEY } as never)
    vi.stubGlobal('fetch', fetch)
    try {
      const answer = await gw.opsRunVariables(names(run(WF)))
      expect(answer.runs).toEqual([{ workflow_id: WF, version_number: 3, values: {}, secret_keys: ['TOKEN'], served_at: expect.any(String) }])
      expect(vi.mocked(decryptSecret)).not.toHaveBeenCalled()
      expect(JSON.stringify(answer)).not.toContain('fake entrypoint plaintext')
      // The control: the same entrypoint without names decrypts.
      const decrypted = await gw.opsRunVariables(ask(run(WF)))
      expect(decrypted.runs[0]).toMatchObject({ secret_values: { TOKEN: 'fake entrypoint plaintext' } })
      expect(vi.mocked(decryptSecret)).toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('the decrypting reader refuses a names request, so a mis-routed one is loud rather than decrypted', async () => {
    const { client, queries } = db({ workflows: [wf(WF)], versions: [], env: [] })
    await expect(readOpsRunVariables(client, KEY, names(run(WF)), NOW)).rejects.toThrow(/names/)
    expect(queries).toEqual([])
    expect(vi.mocked(decryptSecret)).not.toHaveBeenCalled()
  })

  describe('the answer, as the ops copy refresh reads it', () => {
    const asked = names(run(WF), run(WF2, 1))
    const served = { workflow_id: WF, version_number: 3, values: { API_BASE: 'base' }, secret_keys: ['TOKEN'], served_at: '2026-10-29T13:00:00.000Z' }
    const refused = { workflow_id: WF2, version_number: 1, refused: 'not_ops_lane', keys: [] }

    it('reads each run served by name, or refused', () => {
      expect(parseServedOpsRunVariableNames({ organization_id: ORG, runs: [served, refused] }, asked)).toEqual({
        runs: [
          { kind: 'served', workflowId: WF, versionNumber: 3, values: { API_BASE: 'base' }, secretKeys: ['TOKEN'], servedAt: '2026-10-29T13:00:00.000Z' },
          { kind: 'refused', workflowId: WF2, versionNumber: 1, reason: 'not_ops_lane', keys: [] },
        ],
        unreadable: [],
      })
    })

    it('never accepts a secret value: a run served with secret_values (a bidding Worker that ignored names) is unreadable, and its values are not quoted', () => {
      const decrypted = { workflow_id: WF, version_number: 3, values: { API_BASE: 'base' }, secret_values: { TOKEN: 'fake do not echo me' }, served_at: '2026-10-29T13:00:00.000Z' }
      const read = parseServedOpsRunVariableNames({ organization_id: ORG, runs: [decrypted, refused] }, asked)
      expect(read.runs).toEqual([{ kind: 'refused', workflowId: WF2, versionNumber: 1, reason: 'not_ops_lane', keys: [] }])
      expect(read.unreadable.join('\n')).toContain(WF)
      expect(JSON.stringify(read)).not.toContain('fake do not echo me')
    })

    it('names, without failing the rest, a run whose names it cannot read', () => {
      for (const bad of [
        { ...served, secret_keys: 'TOKEN' }, { ...served, secret_keys: ['bad key'] }, { ...served, secret_keys: ['API_BASE'] }, { ...served, secret_keys: ['TOKEN', 'TOKEN'] }, { ...served, extra: true },
      ]) {
        const read = parseServedOpsRunVariableNames({ organization_id: ORG, runs: [bad, refused] }, asked)
        expect(read.runs, JSON.stringify(bad)).toHaveLength(1)
        expect(read.unreadable.join('\n'), JSON.stringify(bad)).toContain(WF)
      }
    })

    it('each reader refuses the other mode\'s request, so names and values can never be read as each other', () => {
      expect(() => parseServedOpsRunVariableNames({ organization_id: ORG, runs: [] }, ask(run(WF)))).toThrow(OpsGatewayContractError)
      expect(() => parseServedOpsRunVariables({ organization_id: ORG, runs: [] }, asked)).toThrow(OpsGatewayContractError)
    })
  })
})
