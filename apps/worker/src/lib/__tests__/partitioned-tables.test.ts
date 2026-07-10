import { describe, it, expect } from 'vitest'
import { PARTITIONED_TABLES, partitionKeyFor } from '../partitioned-tables'

describe('partitioned-tables registry', () => {
  it('registers every monthly-partitioned table with its verified partition key', () => {
    // Keys verified against the migrations, not guessed:
    //   20260430000001_lead_sightings.sql  → execution_started_at_utc, attempted_at_utc
    //   20260610000001_achieve_evaluations.sql → requested_at_utc
    expect(PARTITIONED_TABLES).toEqual({
      lead_sightings: 'execution_started_at_utc',
      lead_sighting_bids: 'attempted_at_utc',
      achieve_evaluations: 'requested_at_utc',
    })
  })

  it('returns the partition key for a registered table', () => {
    expect(partitionKeyFor('lead_sighting_bids')).toBe('attempted_at_utc')
  })

  it('throws for an unregistered table rather than silently returning undefined', () => {
    expect(() => partitionKeyFor('workflow_executions')).toThrow()
  })
})
