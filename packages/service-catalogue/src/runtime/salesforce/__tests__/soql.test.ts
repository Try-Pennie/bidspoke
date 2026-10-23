import { describe, expect, it } from 'vitest'
import { ActionFailure } from '../../failure'
import type { JsonValue } from '../../types'
import { bindSoql } from '../soql'

/**
 * A step's values reach a SOQL query only as `?` binds, each written as a SOQL
 * literal (#2337), so no value can become query text: a name with a quote in it
 * stays one string. SOQL has no bind parameters of its own in the REST API, so
 * the escaping is Salesforce's documented quoted string escapes (SOQL and SOSL
 * Reference, "Quoted String Escape Sequences").
 */

function refusal(query: string, binds: JsonValue | undefined): ActionFailure {
  try {
    bindSoql(query, binds)
  } catch (err) {
    expect(err).toBeInstanceOf(ActionFailure)
    return err as ActionFailure
  }
  throw new Error('expected a refusal')
}

describe('bindSoql', () => {
  it('leaves a query with no placeholder and no binds as it is', () => {
    expect(bindSoql("SELECT Id FROM Lead WHERE Status = 'Open?'", undefined)).toBe("SELECT Id FROM Lead WHERE Status = 'Open?'")
  })

  it('writes each value as a SOQL literal, a string quoted and escaped so it cannot end early', () => {
    expect(bindSoql('SELECT Id FROM Lead WHERE LastName = ? AND Age__c > ? AND IsDeleted = ? AND Note__c = ?', ["O'Brien\\", 41.5, false, null]))
      .toBe("SELECT Id FROM Lead WHERE LastName = 'O\\'Brien\\\\' AND Age__c > 41.5 AND IsDeleted = false AND Note__c = null")
  })

  it('escapes line breaks, tabs and double quotes as SOQL does', () => {
    expect(bindSoql('SELECT Id FROM Lead WHERE Description = ?', ['a\nb\r\tc"d'])).toBe("SELECT Id FROM Lead WHERE Description = 'a\\nb\\r\\tc\\\"d'")
  })

  it('a value that tries to close the string and add a clause stays inside the one string', () => {
    const bound = bindSoql('SELECT Id FROM Lead WHERE Email = ?', ["x' OR Email != '"])
    expect(bound).toBe("SELECT Id FROM Lead WHERE Email = 'x\\' OR Email != \\''")
  })

  it('writes a list as an IN list, and dates and date times unquoted only when they are one', () => {
    expect(bindSoql('SELECT Id FROM Lead WHERE Id IN ? AND CreatedDate >= ? AND Birthdate = ?', [['00Q1', '00Q2'], { datetime: '2026-10-22T13:00:00Z' }, { date: '2026-10-22' }]))
      .toBe("SELECT Id FROM Lead WHERE Id IN ('00Q1', '00Q2') AND CreatedDate >= 2026-10-22T13:00:00Z AND Birthdate = 2026-10-22")
  })

  it('reads a ? inside a quoted string, after an escaped quote, as text and not a placeholder', () => {
    expect(bindSoql("SELECT Id FROM Lead WHERE Name = 'it\\'s ?' AND Email = ?", ['a@b.co'])).toBe("SELECT Id FROM Lead WHERE Name = 'it\\'s ?' AND Email = 'a@b.co'")
  })

  it('refuses a count of binds that does not match the placeholders, by name', () => {
    expect(refusal('SELECT Id FROM Lead WHERE Email = ?', []).code).toBe('salesforce_binds_mismatch')
    expect(refusal('SELECT Id FROM Lead WHERE Email = ?', undefined).code).toBe('salesforce_binds_mismatch')
    expect(refusal('SELECT Id FROM Lead', ['extra']).code).toBe('salesforce_binds_mismatch')
  })

  it('refuses a value it cannot write as a literal, and never sends a guess', () => {
    const bad: JsonValue[] = [{ name: 'x' }, [], [['nested']], 1e21, { date: '22/10/2026' }, { datetime: '2026-10-22 13:00' }]
    for (const value of bad) {
      const r = refusal('SELECT Id FROM Lead WHERE X = ?', [value])
      expect([r.code, r.outcome], JSON.stringify(value)).toEqual(['salesforce_argument_invalid', 'not_applied'])
    }
    expect(refusal('SELECT Id FROM Lead WHERE X = ?', 'not a list').code).toBe('salesforce_argument_invalid')
  })

  it('refuses a query whose quoted string never ends', () => {
    expect(refusal("SELECT Id FROM Lead WHERE Name = 'open", undefined).code).toBe('salesforce_query_invalid')
  })
})
