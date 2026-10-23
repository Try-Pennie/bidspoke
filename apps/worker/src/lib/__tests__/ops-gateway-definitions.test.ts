/**
 * A workflow version's definition, served to the ops Worker (#1950, PR 4 of B3).
 *
 * The bidding database stays the one home of every definition (decision 4 on
 * #1949). The ops tick asks here for the versions its frozen copy
 * (ops_workflow_definitions, Dan's decision recorded on #1950 2026-10-22) does
 * not hold yet, a few at a time, so a run executes the version it started on
 * through a bidding outage. These tests prove both halves of that contract:
 * the bidding Worker reads one version of one ops lane workflow, never a money
 * lane one, and says which it could not serve; the ops Worker refuses an answer
 * it did not ask for or cannot read.
 */
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import {
  MAX_DEFINITIONS_PER_REQUEST, OPS_TICK_MODES, OpsGatewayContractError, parseOpsDefinitionRequest, parseServedOpsDefinitions,
} from '../ops-gateway-contract'
import { readOpsWorkflowDefinitions } from '../ops-gateway'

const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const WF = '00000000-0000-4000-8000-0000000019a1'
const WF2 = '00000000-0000-4000-8000-0000000019a2'
const DEF = { trigger: { type: 'schedule', config: {} }, nodes: [{ id: 'a', type: 'transform' }], edges: [] }

/** PostgREST for workflow_versions: each query answered by `answer(url)`, recorded. */
function versionsDb(answer: (url: URL) => unknown[] | { status: number }) {
  const queries: URL[] = []
  const fakeFetch: typeof globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    queries.push(url)
    const a = answer(url)
    if (!Array.isArray(a)) return Response.json({ code: 'PGRST000', message: 'the database is not answering' }, { status: a.status })
    return Response.json(a)
  }) as typeof globalThis.fetch
  return { client: createClient('https://xvrmivmpfykwwtriqwpg.supabase.co', 'sb_secret_test', { global: { fetch: fakeFetch }, auth: { persistSession: false }, db: { retry: false } } as never), queries }
}

const versionRow = (over: Record<string, unknown> = {}) => ({ workflow_id: WF, version_number: 3, definition: DEF, workflows: { organization_id: ORG, lane: 'ops' }, ...over })

describe('the request the ops tick sends', () => {
  it('reads a list of workflow versions, at most MAX_DEFINITIONS_PER_REQUEST', () => {
    expect(parseOpsDefinitionRequest({ versions: [{ workflow_id: WF, version_number: 3 }] })).toEqual({ versions: [{ workflow_id: WF, version_number: 3 }] })
    const many = Array.from({ length: MAX_DEFINITIONS_PER_REQUEST + 1 }, () => ({ workflow_id: WF, version_number: 1 }))
    expect(() => parseOpsDefinitionRequest({ versions: many })).toThrow(OpsGatewayContractError)
  })

  it('refuses anything else by name, before any read', () => {
    for (const bad of [null, [], { versions: 'x' }, { versions: [{ workflow_id: 'nope', version_number: 1 }] }, { versions: [{ workflow_id: WF, version_number: 0 }] },
      { versions: [{ workflow_id: WF, version_number: 1.5 }] }, { versions: [{ workflow_id: WF, version_number: 1, extra: true }] }]) {
      expect(() => parseOpsDefinitionRequest(bad)).toThrow(OpsGatewayContractError)
    }
  })
})

describe('readOpsWorkflowDefinitions (the bidding Worker)', () => {
  it('reads each version of an ops lane workflow by its workflow and number, and serves its definition with its organization', async () => {
    const { client, queries } = versionsDb(() => [versionRow()])
    const served = await readOpsWorkflowDefinitions(client, { versions: [{ workflow_id: WF, version_number: 3 }] })
    expect(served).toEqual({ definitions: [{ workflow_id: WF, organization_id: ORG, version_number: 3, definition: DEF }], unserved: [] })
    const q = queries[0]
    expect(q.pathname).toBe('/rest/v1/workflow_versions')
    expect(q.searchParams.get('workflow_id')).toBe(`eq.${WF}`)
    expect(q.searchParams.get('version_number')).toBe('eq.3')
    expect(q.searchParams.get('workflows.lane')).toBe('eq.ops')
    expect(q.searchParams.get('select')).toMatch(/workflows!inner\(organization_id,\s*lane\)/)
  })

  it('names a version it has no row for, and a row of another lane the filter let through, as unserved', async () => {
    const { client } = versionsDb((url) => (url.searchParams.get('workflow_id') === `eq.${WF}` ? [] : [versionRow({ workflow_id: WF2, workflows: { organization_id: ORG, lane: 'money' } })]))
    const served = await readOpsWorkflowDefinitions(client, { versions: [{ workflow_id: WF, version_number: 3 }, { workflow_id: WF2, version_number: 1 }] })
    expect(served.definitions).toEqual([])
    expect(served.unserved).toEqual([{ workflow_id: WF, version_number: 3 }, { workflow_id: WF2, version_number: 1 }])
  })

  it('throws on a failed read rather than serving it as unserved', async () => {
    const { client } = versionsDb(() => ({ status: 503 }))
    await expect(readOpsWorkflowDefinitions(client, { versions: [{ workflow_id: WF, version_number: 3 }] })).rejects.toThrow(/workflow definitions/)
  })
})

describe('parseServedOpsDefinitions (the ops Worker)', () => {
  const asked = [{ workflowId: WF, versionNumber: 3 }, { workflowId: WF2, versionNumber: 1 }]

  it('reads the definitions and the versions not served', () => {
    const parsed = parseServedOpsDefinitions({
      definitions: [{ workflow_id: WF, organization_id: ORG, version_number: 3, definition: DEF }],
      unserved: [{ workflow_id: WF2, version_number: 1 }],
    }, asked)
    expect(parsed).toEqual({
      definitions: [{ workflowId: WF, organizationId: ORG, versionNumber: 3, definition: DEF }],
      unserved: [{ workflowId: WF2, versionNumber: 1 }],
      refused: [],
    })
  })

  it('refuses a definition it did not ask for, or one that is not an object, and names it', () => {
    const parsed = parseServedOpsDefinitions({
      definitions: [
        { workflow_id: WF, organization_id: ORG, version_number: 4, definition: DEF },
        { workflow_id: WF2, organization_id: ORG, version_number: 1, definition: [1] },
      ],
      unserved: [],
    }, asked)
    expect(parsed.definitions).toEqual([])
    expect(parsed.refused.map((r) => r.workflowId)).toEqual([WF, WF2])
    expect(parsed.refused[0].text).toMatch(/did not ask for/)
    expect(parsed.refused[1].text).toMatch(/shape/)
  })

  it('refuses an unserved version it did not ask about, rather than paging for it', () => {
    const parsed = parseServedOpsDefinitions({ definitions: [], unserved: [{ workflow_id: WF, version_number: 9 }, { workflow_id: WF2, version_number: 1 }] }, asked)
    expect(parsed.unserved).toEqual([{ workflowId: WF2, versionNumber: 1 }])
    expect(parsed.refused).toEqual([{ workflowId: WF, text: expect.stringMatching(/did not ask about/) }])
  })

  it('throws on an answer that is not the shape', () => {
    expect(() => parseServedOpsDefinitions(null, asked)).toThrow(OpsGatewayContractError)
    expect(() => parseServedOpsDefinitions({ definitions: [] }, asked)).toThrow(OpsGatewayContractError)
  })
})

describe('the tick modes the bidding Worker reads', () => {
  it('knows live before the ops Worker can send it, so a report in live mode is read rather than refused (L640)', () => {
    expect(OPS_TICK_MODES).toEqual(['observe', 'live'])
  })
})
