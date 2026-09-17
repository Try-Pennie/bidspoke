/**
 * The engine side of the sandbox capture (#1265): the bundle records raw non-2xx responses,
 * the worker's one detector decides, and a bundle built before the capture existed is
 * counted rather than mistaken for a quiet one.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { DispatchNamespace } from '@cloudflare/workers-types'
import { executeCodeNode } from '../code'
import { drainBlockSightings } from '../../block-sightings'
import { parseCodeSandboxResponse } from '../../code-response'
import { ACHIEVE_CLOUDFLARE_BLOCK_PAGE } from '../../../lib/__tests__/fixtures/achieve-cloudflare-block-page'
import type { Env } from '../../../index'
import type { ExecutionContext, NodeDefinition } from '../../../types'

function ctx(): ExecutionContext {
  return {
    trigger: { payload: {}, source: 'test', workflow_id: 'wf-abc123', org_id: 'org-1', trace_id: 'trace' },
    steps: {},
    env: {},
  } as unknown as ExecutionContext
}

const node = (): NodeDefinition => ({ id: 'n1', namespace: 'scout', type: 'code', config: { script: 'return 1' } })

function envAnswering(body: unknown, status = 200): Env {
  return {
    DYNAMIC_WORKER_LOADER: {
      get: vi.fn(() => ({ fetch: vi.fn(async () => new Response(JSON.stringify(body), { status })) })),
    } as unknown as DispatchNamespace,
  } as unknown as Env
}

const record = { host: 'oauth.prd.ffngcp.com', url: 'https://oauth.prd.ffngcp.com/v1/token', status: 403, contentType: 'text/html', cfRay: 'a369312f2f2faa85-EWR', cfMitigated: null, bodyHead: ACHIEVE_CLOUDFLARE_BLOCK_PAGE.slice(0, 8192) }

afterEach(() => { vi.restoreAllMocks() })

describe('parseCodeSandboxResponse carries the bundle\'s block records', () => {
  it('on a successful envelope and on an error envelope alike', () => {
    expect(parseCodeSandboxResponse(true, JSON.stringify({ __bsv: 1, output: 1, blocks: [record] }))).toMatchObject({ ok: true, blocks: [record] })
    expect(parseCodeSandboxResponse(false, JSON.stringify({ __bsv: 1, error: 'boom', name: 'Error', blocks: [record] }))).toMatchObject({ ok: false, blocks: [record] })
  })

  it('reports the key as absent for a bundle built before the capture existed', () => {
    expect(parseCodeSandboxResponse(true, JSON.stringify({ __bsv: 1, output: 1 })).blocks).toBeUndefined()
  })
})

describe('executeCodeNode turns records into sightings through the one detector', () => {
  it('notes a sighting for a block page record, named as the code step', async () => {
    const c = ctx()
    await executeCodeNode(node(), c, envAnswering({ __bsv: 1, output: { ok: false }, blocks: [record] }))
    const seen = drainBlockSightings(c)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ host: 'oauth.prd.ffngcp.com', status: 403, vendor: 'cloudflare', bodyRayId: 'a369312f2f2faa85', edgeRayId: 'a369312f2f2faa85-EWR', seenIn: 'code:scout' })
  })

  it('notes nothing for a JSON 403 record, which is a partner answer, not a block', async () => {
    const c = ctx()
    await executeCodeNode(node(), c, envAnswering({ __bsv: 1, output: 1, blocks: [{ ...record, contentType: 'application/json', bodyHead: '{"error":"forbidden"}' }] }))
    expect(drainBlockSightings(c)).toHaveLength(0)
  })

  it('still notes the sighting when the script threw after the fetch', async () => {
    const c = ctx()
    await expect(executeCodeNode(node(), c, envAnswering({ __bsv: 1, error: 'HTTP 403', name: 'Error', blocks: [record] }, 500))).rejects.toThrow('HTTP 403')
    expect(drainBlockSightings(c)).toHaveLength(1)
  })

  it('counts a bundle without the capture in the log, once, so coverage is measurable', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const env = envAnswering({ __bsv: 1, output: 1 })
    await executeCodeNode(node(), ctx(), env)
    await executeCodeNode(node(), ctx(), env)
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('event=code_bundle_without_block_capture'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('workflow=wf-abc123')
  })
})
