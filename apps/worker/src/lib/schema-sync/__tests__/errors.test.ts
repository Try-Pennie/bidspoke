/**
 * The schema lookups' failure words (#2335 PR 7; #2338 build PR 4).
 *
 * Every step a lookup can fail at is named in its message, so a person reading
 * "Salesforce ... failed" knows which request it was. The list below is keyed
 * by SchemaStep, so a step added without words, or a step left behind after
 * its last thrower went (the legacy credentials reader, #2338), fails to
 * compile here.
 */
import { describe, expect, it } from 'vitest'
import { SchemaLookupError, type SchemaStep } from '../errors'

const STEP_WORDS: Record<SchemaStep, string> = {
  key: 'look up Lead',
  object_list: 'list its objects',
  object_describe: 'describe Lead',
  openapi: 'list its tables',
  statement: 'run the schema query',
  statement_poll: 'check on the schema query',
  statement_partition: 'fetch result part Lead',
}

describe('each step a lookup can fail at is named in its message', () => {
  for (const [step, words] of Object.entries(STEP_WORDS) as Array<[SchemaStep, string]>) {
    it(step, () => {
      const err = new SchemaLookupError({ code: 'schema_service_error', service: 'salesforce', step, subject: 'Lead', status: 500 })
      expect(err.message).toContain(words)
    })
  }

  it('a query still running says to try again, and names no control that no longer exists', () => {
    const err = new SchemaLookupError({ code: 'schema_query_still_running', service: 'snowflake', step: 'statement_poll' })
    expect(err.message).toContain('try again in a moment')
    expect(err.message).not.toMatch(/Sync/)
  })
})
