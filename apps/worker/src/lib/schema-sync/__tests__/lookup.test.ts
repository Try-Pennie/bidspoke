/**
 * lookupSchema(source, key, parents): the keyed lookups behind the ops
 * connection dropdowns (#2335, PR 7 of phase 5; OpsConnections.lookup calls it
 * in PR 8 through connectionFetch).
 */
import { describe, it, expect } from 'vitest'
import { lookupSchema, SCHEMA_LOOKUP_KEYS } from '../lookup'
import { ConnectionRefusal } from '../../../ops/connections/refusals'
import type { SchemaSource } from '../types'
import { caught, fetchSequence, json, text } from './_fetch'


const SOBJECTS = { sobjects: [{ name: 'Submission__c', label: 'Submission', queryable: true }] }
const DESCRIBE = { fields: [{ name: 'Id', label: 'Record ID', type: 'id', nillable: false }] }

function salesforce(fetch: SchemaSource['fetch']): SchemaSource {
  return { service: 'salesforce', fetch, auth: {}, instanceUrl: 'https://test.my.salesforce.com' }
}

describe('lookupSchema', () => {
  it('names the keys each service answers', () => {
    expect(SCHEMA_LOOKUP_KEYS).toEqual({
      salesforce: ['objects', 'fields'],
      supabase: ['tables', 'columns'],
      snowflake: ['tables', 'columns'],
    })
  })

  it('objects', async () => {
    const answer = await lookupSchema(salesforce(fetchSequence(json(200, SOBJECTS)).fetch), 'objects', [])
    expect(answer).toEqual({ key: 'objects', entries: [{ name: 'Submission__c', label: 'Submission' }] })
  })

  it('fields of an object', async () => {
    const answer = await lookupSchema(salesforce(fetchSequence(json(200, DESCRIBE)).fetch), 'fields', ['Submission__c'])
    expect(answer).toEqual({
      key: 'fields',
      parent: 'Submission__c',
      fields: [{ name: 'Id', label: 'Record ID', type: 'id', nullable: false }],
    })
  })

  it('tables and columns of a Supabase table', async () => {
    const spec = { definitions: { leads: { properties: { id: { format: 'uuid' } }, required: ['id'] } } }
    const source: SchemaSource = { service: 'supabase', fetch: fetchSequence(json(200, spec)).fetch, auth: {}, url: 'https://x.supabase.co' }
    expect(await lookupSchema(source, 'tables', [])).toEqual({ key: 'tables', entries: [{ name: 'leads', label: 'leads' }] })
    const again: SchemaSource = { ...source, fetch: fetchSequence(json(200, spec)).fetch }
    expect(await lookupSchema(again, 'columns', ['leads'])).toEqual({
      key: 'columns',
      parent: 'leads',
      fields: [{ name: 'id', label: 'id', type: 'uuid', nullable: false }],
    })
  })

  it('refuses a key the service does not answer, before sending anything', async () => {
    const { fetch } = fetchSequence(json(200, SOBJECTS))
    const err = await caught(lookupSchema(salesforce(fetch), 'tables', []))
    expect(err.code).toBe('schema_key_invalid')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses the wrong number of parents, before sending anything', async () => {
    const { fetch } = fetchSequence(json(200, DESCRIBE))
    expect((await caught(lookupSchema(salesforce(fetch), 'fields', []))).code).toBe('schema_key_invalid')
    expect((await caught(lookupSchema(salesforce(fetch), 'objects', ['Lead']))).code).toBe('schema_key_invalid')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a failed describe is the named error, never an answer with an empty field list', async () => {
    const err = await caught(lookupSchema(salesforce(fetchSequence(text(503, 'down')).fetch), 'fields', ['Submission__c']))
    expect([err.code, err.step, err.subject]).toEqual(['schema_service_error', 'object_describe', 'Submission__c'])
  })

  it('keeps the name of a refusal the injected fetch threw (connectionFetch on ops)', async () => {
    const refusing = fetchSequence(new ConnectionRefusal('connection_needs_reauth', 'salesforce request refused after renewal'))
    const err = await caught(lookupSchema(salesforce(refusing.fetch), 'objects', []))
    expect([err.code, err.upstreamCode]).toEqual(['schema_request_failed', 'connection_needs_reauth'])
    expect(err.message).toContain('connection_needs_reauth')

    const timedOut = fetchSequence(new ConnectionRefusal('connection_timeout', 'deadline passed'))
    const late = await caught(lookupSchema(salesforce(timedOut.fetch), 'objects', []))
    expect([late.code, late.upstreamCode]).toEqual(['schema_request_timeout', 'connection_timeout'])
  })
})
