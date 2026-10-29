/**
 * Which live workflows a variable change would break (#3001, phase 5 of
 * #2982): Dan's decision of 2026-10-29, deleting or emptying a variable is
 * refused while any live workflow reads it, and a rename is refused the same
 * way until #2996 ships. The judgement is the one pure function here, driven
 * directly; the route tests in routes/api/__tests__/env.test.ts drive the reads
 * and the answer around it.
 */
import { describe, expect, it } from 'vitest'
import { workflowsLosingVariable, variableInUseMessage, type VariableRow, type LiveWorkflow } from '../variable-in-use'

const ORG_ROW: VariableRow = { id: 'row-org', key: 'API_URL', scope: 'global', workflow_id: null, value: 'https://example.test' }

const reads = (key: string) => ({ nodes: [{ id: 'n1', type: 'http', config: { url: `{{env.${key}}}/leads` } }], edges: [] })
const live = (id: string, name: string, definition: unknown = reads('API_URL')): LiveWorkflow => ({ id, name, definition })

describe('workflowsLosingVariable (#3001)', () => {
  it('names a live workflow that reads the key from the organization row', () => {
    expect(workflowsLosingVariable(ORG_ROW, [ORG_ROW], [live('w1', 'Main Flow')])).toEqual([{ id: 'w1', name: 'Main Flow' }])
  })

  it('names nobody when no live workflow reads the key', () => {
    expect(workflowsLosingVariable(ORG_ROW, [ORG_ROW], [live('w1', 'Main Flow', reads('OTHER_KEY'))])).toEqual([])
  })

  it('names nobody when every reader has its own row for the key', () => {
    const own: VariableRow = { id: 'row-w1', key: 'API_URL', scope: 'workflow', workflow_id: 'w1', value: 'https://own.example.test' }
    expect(workflowsLosingVariable(ORG_ROW, [ORG_ROW, own], [live('w1', 'Main Flow')])).toEqual([])
  })

  it('names only the readers that do not override it', () => {
    const own: VariableRow = { id: 'row-w1', key: 'API_URL', scope: 'workflow', workflow_id: 'w1', value: 'https://own.example.test' }
    expect(workflowsLosingVariable(ORG_ROW, [ORG_ROW, own], [live('w1', 'Main Flow'), live('w2', 'Engine')])).toEqual([{ id: 'w2', name: 'Engine' }])
  })

  it('a workflow row blocks only its own workflow, and its organization value showing through breaks nobody', () => {
    const own: VariableRow = { id: 'row-w1', key: 'API_URL', scope: 'workflow', workflow_id: 'w1', value: 'https://own.example.test' }
    const workflows = [live('w1', 'Main Flow'), live('w2', 'Engine')]
    expect(workflowsLosingVariable(own, [own], workflows)).toEqual([{ id: 'w1', name: 'Main Flow' }])
    expect(workflowsLosingVariable(own, [ORG_ROW, own], workflows)).toEqual([])
  })

  it('a row with no value already gives nothing, so changing it breaks nobody', () => {
    const empty: VariableRow = { ...ORG_ROW, value: '' }
    expect(workflowsLosingVariable(empty, [empty], [live('w1', 'Main Flow')])).toEqual([])
  })

  it('reads env.KEY as a path too, as envReferences does', () => {
    const definition = { nodes: [{ id: 'n1', type: 'condition', config: { field: 'env.API_URL' } }], edges: [] }
    expect(workflowsLosingVariable(ORG_ROW, [ORG_ROW], [live('w1', 'Main Flow', definition)])).toEqual([{ id: 'w1', name: 'Main Flow' }])
  })

  it('a workflow whose definition is not an object reads nothing', () => {
    expect(workflowsLosingVariable(ORG_ROW, [ORG_ROW], [live('w1', 'Main Flow', null)])).toEqual([])
  })

  it('a secret row counts the same as a plain one', () => {
    const secret: VariableRow = { ...ORG_ROW, value: 'stand-in-ciphertext' }
    expect(workflowsLosingVariable(secret, [secret], [live('w1', 'Main Flow')])).toEqual([{ id: 'w1', name: 'Main Flow' }])
  })

  it('orders the workflows by name', () => {
    expect(workflowsLosingVariable(ORG_ROW, [ORG_ROW], [live('w2', 'Zeta'), live('w1', 'Alpha')]).map((w) => w.name)).toEqual(['Alpha', 'Zeta'])
  })
})

describe('variableInUseMessage (#3001)', () => {
  it('names the variable and each workflow, never a value', () => {
    const message = variableInUseMessage('delete', 'API_URL', [{ id: 'w1', name: 'Main Flow' }, { id: 'w2', name: 'Engine' }])
    expect(message).toContain('API_URL')
    expect(message).toContain('Main Flow')
    expect(message).toContain('Engine')
    expect(message).not.toContain('https://example.test')
  })

  it('says what was refused for each kind of change', () => {
    const one = [{ id: 'w1', name: 'Main Flow' }]
    expect(variableInUseMessage('delete', 'API_URL', one)).toMatch(/^Not deleted\./)
    expect(variableInUseMessage('empty', 'API_URL', one)).toMatch(/^Not saved\..*emptied/)
    expect(variableInUseMessage('rename', 'API_URL', one)).toMatch(/^Not saved\..*renamed/)
  })
})
