import { describe, it, expect } from 'vitest'
import { salesforceConfigProblem, findSalesforceConfigProblems, validateWorkflowDef, type NodeDefLike } from '../index'

// The write options a Salesforce step gained for the relay port (#2170). The one
// rule serves the canvas, the worker's save route and the executor, so a value
// refused at save is the value the executor would refuse at run time.

const update = (extra: Record<string, unknown>) => ({ operation: 'update', object: 'Submission__c', ...extra })

describe('salesforceConfigProblem', () => {
  it('accepts a step with none of the options (every existing step)', () => {
    expect(salesforceConfigProblem({ operation: 'update', object: 'Prospect__c', body: {} })).toBeNull()
    expect(salesforceConfigProblem({})).toBeNull()
  })

  it('accepts well formed options on an update', () => {
    expect(salesforceConfigProblem(update({
      omit_fields: ['submissionId', 'executionId'],
      rename_fields: { UUID: 'Engine_UUID_SO__c', leadUUID: 'Engine_Lead_UUID_SO__c' },
      skip_when_empty: true,
    }))).toBeNull()
  })

  it.each([
    ['a string', 'submissionId'],
    ['a list holding a number', ['submissionId', 3]],
    ['a list holding an empty name', ['submissionId', ' ']],
    ['an object', { submissionId: true }],
  ])('refuses omit_fields given %s, by name', (_what, value) => {
    expect(salesforceConfigProblem(update({ omit_fields: value }))).toBe('omit_fields must be a list of field names')
  })

  it.each([
    ['a list', [['UUID', 'Engine_UUID_SO__c']]],
    ['a string', 'UUID'],
    ['null', null],
    ['a number as a new name', { UUID: 7 }],
    ['an empty new name', { UUID: '' }],
  ])('refuses rename_fields given %s, by name', (_what, value) => {
    expect(salesforceConfigProblem(update({ rename_fields: value }))).toBe('rename_fields must map each field name to a new field name')
  })

  it.each(['__proto__', 'constructor x', 'Engine-UUID', '9Field__c', '_Field'])(
    'refuses a rename onto %s, which is not a Salesforce field name',
    (target) => {
      expect(salesforceConfigProblem(update({ rename_fields: { UUID: target } })))
        .toBe(`rename_fields target ${target} is not a Salesforce field name`)
    },
  )

  it('refuses two fields renamed to one name, since one value would be lost', () => {
    expect(salesforceConfigProblem(update({ rename_fields: { UUID: 'X__c', leadUUID: 'X__c' } })))
      .toBe('rename_fields renames two fields to X__c, so one value would be lost')
  })

  it('refuses a skip_when_empty that is not true or false', () => {
    expect(salesforceConfigProblem(update({ skip_when_empty: 'yes' }))).toBe('skip_when_empty must be true or false')
  })

  it.each([
    ['create', { operation: 'create', object: 'Prospect__c' }],
    ['upsert', { operation: 'upsert', object: 'Prospect__c' }],
    ['query', { operation: 'query', soql: 'SELECT Id FROM Lead' }],
    ['an Apex GET', { operation: 'apex', apex_path: '/services/apexrest/x', apex_method: 'GET' }],
  ])('refuses skip_when_empty on %s, which does not read it', (_what, config) => {
    expect(salesforceConfigProblem({ ...config, skip_when_empty: true }))
      .toBe('skip_when_empty applies only to an update or an Apex POST')
  })

  it('accepts skip_when_empty on an Apex POST, whose body may be null when there is nothing to send', () => {
    expect(salesforceConfigProblem({ operation: 'apex', apex_path: '/services/apexrest/credit-inquiries', skip_when_empty: true })).toBeNull()
    expect(salesforceConfigProblem({ operation: 'apex', apex_path: '/services/apexrest/credit-inquiries', apex_method: 'POST', skip_when_empty: true })).toBeNull()
  })

  it.each(['query', 'apex'])('refuses omit_fields and rename_fields on %s, which sends no record body', (operation) => {
    expect(salesforceConfigProblem({ operation, omit_fields: ['a'] })).toBe('omit_fields applies only to create, update and upsert')
    expect(salesforceConfigProblem({ operation, rename_fields: { a: 'b' } })).toBe('rename_fields applies only to create, update and upsert')
  })

  it.each(['create', 'upsert'])('accepts omit_fields and rename_fields on %s', (operation) => {
    expect(salesforceConfigProblem({ operation, omit_fields: ['a'], rename_fields: { b: 'c' } })).toBeNull()
  })
})

describe('the options at save', () => {
  const node = (config: Record<string, unknown>): NodeDefLike => ({ id: 'n1', type: 'salesforce', namespace: 'post', config })

  it('validateWorkflowDef names a malformed option on an attached Salesforce step', () => {
    const errors = validateWorkflowDef([node(update({ omit_fields: 'x' })), { id: 'n2', type: 'exit', namespace: 'done' }], [{ source: 'n1', target: 'n2' }])
    expect(errors.map((e) => [e.namespace, e.message])).toEqual([['post', 'omit_fields must be a list of field names']])
  })

  it('judges only Salesforce steps by the rule, never another type that happens to hold the same key', () => {
    const others = ['response', 'exit', 'branch_end', 'parallel_end', 'constants', 'data_store'].map((type, i): NodeDefLike => ({
      id: `o${i}`, type, namespace: type, config: { omit_fields: 'x', skip_when_empty: 'yes' },
    }))
    const edges = others.slice(1).map((n, i) => ({ source: others[i].id, target: n.id }))
    expect(validateWorkflowDef(others, edges)).toEqual([])
  })

  it('findSalesforceConfigProblems skips node entries that are not objects, leaving them to the checks that own node shape', () => {
    const entries = [null, undefined, 5, 'x', node(update({ omit_fields: 'x' }))] as unknown as NodeDefLike[]
    expect(findSalesforceConfigProblems(entries).map((e) => [e.namespace, e.message])).toEqual([['post', 'omit_fields must be a list of field names']])
  })

  it('findSalesforceConfigProblems names every malformed Salesforce step, attached or not', () => {
    const problems = findSalesforceConfigProblems([
      node(update({ rename_fields: ['x'] })),
      { id: 'n2', type: 'salesforce', namespace: 'fine', config: update({ omit_fields: ['a'] }) },
      { id: 'n3', type: 'code', namespace: 'other', config: { omit_fields: 'not a salesforce step' } },
    ])
    expect(problems.map((e) => [e.namespace, e.message])).toEqual([['post', 'rename_fields must map each field name to a new field name']])
  })
})
