/**
 * The workflow write check (#2338, build PR 7): every route that writes a
 * workflow definition asks definition_connection_problems first and refuses,
 * by name, a definition naming a connection that is not a live one of the
 * caller's organization. A check that cannot be made refuses the save rather
 * than letting it through unchecked, and a write the database trigger refused
 * (a removal that won the race) is answered the same way.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  WORKFLOW_CONNECTION_REFUSAL_CODES, checkDefinitionConnections, connectionRefusalOfWriteError, missingConnectionsSentence,
  type MissingConnection,
} from '../workflow-connection-check'

const ORG = '11111111-1111-1111-1111-111111111111'
const REMOVED = '33333333-3333-3333-3333-333333333301'
const ELSEWHERE = '33333333-3333-3333-3333-333333333302'
const DEF = { nodes: [{ id: 'n1', namespace: 'sf', type: 'code', config: { connection_id: REMOVED } }], edges: [] }

const rpcAnswering = (answer: { data: unknown; error: unknown }) => {
  const rpc = vi.fn(async () => answer)
  return { client: { rpc } as unknown as Parameters<typeof checkDefinitionConnections>[0], rpc }
}

/** The writing rule's forbidden marks (long dashes, curly quotes), built from char codes so this file holds none. */
const FORBIDDEN_MARKS = [0x2014, 0x2013, 0x2018, 0x2019, 0x201c, 0x201d].map((c) => String.fromCharCode(c))

describe('checkDefinitionConnections', () => {
  it('asks the database with the organization and the very definition being written', async () => {
    const { client, rpc } = rpcAnswering({ data: [], error: null })
    expect(await checkDefinitionConnections(client, ORG, DEF)).toBeNull()
    expect(rpc).toHaveBeenCalledWith('definition_connection_problems', { p_organization_id: ORG, p_definition: DEF })
  })

  it('refuses a removed connection by its name and the step naming it, and says to give the step a replacement', async () => {
    const { client } = rpcAnswering({ data: [{ connection_id: REMOVED, problem: 'removed', name: 'Pennie Salesforce', steps: ['sf'] }], error: null })
    const refusal = await checkDefinitionConnections(client, ORG, DEF)
    expect(refusal?.status).toBe(409)
    expect(refusal?.body.code).toBe('workflow_connection_missing')
    expect(refusal?.body.missing_connections).toEqual([{ id: REMOVED, problem: 'removed', name: 'Pennie Salesforce', steps: ['sf'] }])
    expect(refusal?.body.error).toBe('Nothing was saved. The step sf names the connection "Pennie Salesforce", which was removed. Give the step a replacement connection, then save again.')
  })

  it('refuses another organization\'s connection by its id, never a name', async () => {
    const { client } = rpcAnswering({ data: [{ connection_id: ELSEWHERE, problem: 'not_this_organization', name: null, steps: ['ask', 'tell'] }], error: null })
    const refusal = await checkDefinitionConnections(client, ORG, DEF)
    expect(refusal?.status).toBe(409)
    expect(refusal?.body.error).toBe(`Nothing was saved. The steps ask and tell name a connection that is not one of this organization's (${ELSEWHERE}). Give each of those steps a replacement connection, then save again.`)
  })

  it('answers a missing function as its own named refusal, so nothing is saved unchecked before the migration is applied', async () => {
    const { client } = rpcAnswering({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.definition_connection_problems(p_definition, p_organization_id) in the schema cache' } })
    const refusal = await checkDefinitionConnections(client, ORG, DEF)
    expect(refusal?.status).toBe(503)
    expect(refusal?.body.code).toBe('workflow_connection_check_unavailable')
    expect(refusal?.body.error).toMatch(/^Nothing was saved\./)
  })

  it('answers a lookup that failed as a refusal, never as no problem', async () => {
    const { client } = rpcAnswering({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })
    const refusal = await checkDefinitionConnections(client, ORG, DEF)
    expect(refusal?.status).toBe(503)
    expect(refusal?.body.code).toBe('workflow_connection_check_failed')
  })

  it('answers a lookup that threw as a refusal', async () => {
    const client = { rpc: vi.fn(async () => { throw new TypeError('fetch failed') }) } as unknown as Parameters<typeof checkDefinitionConnections>[0]
    expect((await checkDefinitionConnections(client, ORG, DEF))?.body.code).toBe('workflow_connection_check_failed')
  })

  it.each([
    ['no rows at all (null)', null],
    ['an object, not a list', { connection_id: REMOVED }],
    ['a row of an unknown problem', [{ connection_id: REMOVED, problem: 'gone', name: null, steps: [] }]],
    ['a row with no steps list', [{ connection_id: REMOVED, problem: 'removed', name: null }]],
  ])('refuses an answer it cannot read (%s) rather than passing the save', async (_label, data) => {
    const { client } = rpcAnswering({ data, error: null })
    expect((await checkDefinitionConnections(client, ORG, DEF))?.body.code).toBe('workflow_connection_check_failed')
  })
})

describe('connectionRefusalOfWriteError', () => {
  it('reads the trigger\'s refusal, naming each connection from its detail', () => {
    const refusal = connectionRefusalOfWriteError({
      code: 'BP409',
      message: 'workflow_names_missing_connection',
      details: JSON.stringify([{ id: REMOVED, problem: 'removed', name: 'Pennie Salesforce', steps: ['sf'] }]),
    })
    expect(refusal?.status).toBe(409)
    expect(refusal?.body.code).toBe('workflow_connection_missing')
    expect(refusal?.body.error).toContain('"Pennie Salesforce", which was removed')
  })

  it('still refuses, without names, when the detail cannot be read', () => {
    const refusal = connectionRefusalOfWriteError({ code: 'BP409', message: 'workflow_names_missing_connection', details: 'not json' })
    expect(refusal?.status).toBe(409)
    expect(refusal?.body.code).toBe('workflow_connection_missing')
    expect(refusal?.body.missing_connections).toEqual([])
    expect(refusal?.body.error).toMatch(/^Nothing was saved\./)
  })

  it('is not another BP409, nor any other error', () => {
    expect(connectionRefusalOfWriteError({ code: 'BP409', message: 'stale_version' })).toBeNull()
    expect(connectionRefusalOfWriteError({ code: '23505', message: 'duplicate key' })).toBeNull()
    expect(connectionRefusalOfWriteError(null)).toBeNull()
  })
})

describe('the sentences', () => {
  const removedUnnamed: MissingConnection = { id: REMOVED, problem: 'removed', name: null, steps: [] }

  it('name a removed connection whose name is lost by its id, and one no step holds as the workflow\'s', () => {
    expect(missingConnectionsSentence([removedUnnamed])).toBe(
      `Nothing was saved. This workflow names a connection that was removed (${REMOVED}). Replace it with a connection of this organization, then save again.`,
    )
  })

  it('name every connection, one sentence each', () => {
    const s = missingConnectionsSentence([
      { id: REMOVED, problem: 'removed', name: 'Pennie Salesforce', steps: ['sf'] },
      { id: ELSEWHERE, problem: 'not_this_organization', name: null, steps: ['ask'] },
    ])
    expect(s).toBe(`Nothing was saved. The step sf names the connection "Pennie Salesforce", which was removed. The step ask names a connection that is not one of this organization's (${ELSEWHERE}). Give each of those steps a replacement connection, then save again.`)
  })

  it.each([...WORKFLOW_CONNECTION_REFUSAL_CODES])('%s holds none of the forbidden marks', async (code) => {
    const sentences: Record<string, string> = {
      workflow_connection_missing: missingConnectionsSentence([removedUnnamed]),
      workflow_connection_check_unavailable: (await checkDefinitionConnections(rpcAnswering({ data: null, error: { code: 'PGRST202', message: 'x' } }).client, ORG, DEF))!.body.error,
      workflow_connection_check_failed: (await checkDefinitionConnections(rpcAnswering({ data: null, error: { code: 'XX000', message: 'x' } }).client, ORG, DEF))!.body.error,
    }
    for (const mark of FORBIDDEN_MARKS) expect(sentences[code]).not.toContain(mark)
    expect(sentences[code]).toMatch(/^Nothing was saved\. .+\.$/)
  })
})
