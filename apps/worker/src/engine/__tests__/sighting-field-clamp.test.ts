/**
 * Issue #91: state was written raw into VARCHAR(2) (lead_sightings + persons) and
 * a non-conforming ssn into VARCHAR(11). A source sending "California" (or a
 * malformed SSN) overflowed the column and failed the *entire* best-effort
 * sighting insert, silently dropping the whole row instead of one field.
 *
 * extractSightingFields/extractPersonFields now normalize state to a 2-letter
 * code (or null), and insertSighting drops an over-length ssn to null.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  extractSightingFields,
  extractPersonFields,
  insertSighting,
  type SightingInsert,
} from '../lead-sightings'

describe('normalizeState (#91)', () => {
  // extractPersonFields returns null unless an ssn is present.
  const withState = (state: unknown) => ({ personalInformation: { ssn: '123-45-6789', state } })

  it('maps a full state name to its 2-letter code', () => {
    expect(extractSightingFields(withState('California')).state).toBe('CA')
    expect(extractPersonFields(withState('California'))!.state).toBe('CA')
  })

  it('is case-insensitive and trims for both names and codes', () => {
    expect(extractSightingFields(withState('  new york  ')).state).toBe('NY')
    expect(extractSightingFields(withState('ca')).state).toBe('CA')
    expect(extractSightingFields(withState('CA')).state).toBe('CA')
  })

  it('maps DC and territories', () => {
    expect(extractSightingFields(withState('District of Columbia')).state).toBe('DC')
    expect(extractSightingFields(withState('Puerto Rico')).state).toBe('PR')
  })

  it('drops unrecognized values to null instead of overflowing VARCHAR(2)', () => {
    expect(extractSightingFields(withState('Calif')).state).toBeNull()
    expect(extractSightingFields(withState('XYZ')).state).toBeNull()
    expect(extractSightingFields(withState('')).state).toBeNull()
    expect(extractSightingFields(withState(undefined)).state).toBeNull()
  })

  it('always yields at most 2 characters for any string input', () => {
    for (const v of ['California', 'CA', 'ca', 'new york', 'garbage', 'X']) {
      const out = extractSightingFields(withState(v)).state
      expect(out == null || out.length <= 2).toBe(true)
    }
  })
})

describe('insertSighting ssn guard (#91)', () => {
  function makeSupabase() {
    const captured: { row?: Record<string, unknown> } = {}
    const client = {
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          captured.row = row
          return Promise.resolve({ error: null })
        },
      }),
    } as unknown as SupabaseClient
    return { client, captured }
  }

  const base: Omit<SightingInsert, 'ssn'> = {
    id: 'sight-1',
    trace_id: 't',
    execution_id: 'e',
    workflow_id: 'w',
    is_test: false,
    execution_started_at_utc: new Date('2026-06-15T00:00:00Z'),
    execution_started_at_et: new Date('2026-06-15T00:00:00Z'),
    payload_fields: {},
  }

  it('keeps a conforming 11-char ssn', async () => {
    const { client, captured } = makeSupabase()
    const id = await insertSighting(client, { ...base, ssn: '123-45-6789' })
    expect(id).toBe('sight-1')
    expect(captured.row!.ssn).toBe('123-45-6789')
  })

  it('drops an over-length ssn to null rather than failing the insert', async () => {
    const { client, captured } = makeSupabase()
    const id = await insertSighting(client, { ...base, ssn: '123456789012345' })
    expect(id).toBe('sight-1')
    expect(captured.row!.ssn).toBeNull()
  })

  it('passes through a null ssn', async () => {
    const { client, captured } = makeSupabase()
    await insertSighting(client, { ...base, ssn: null })
    expect(captured.row!.ssn).toBeNull()
  })
})
