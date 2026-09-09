/**
 * Erasing one subject from every place their identity landed (#875, Phase A7).
 *
 * Drives the real `eraseSubject` against a Snowflake double, so what is asserted
 * is the statements it actually issued and what it reported, not which functions
 * ran.
 *
 * The outcomes the phase requires a test for, each produced here: zero rows;
 * rows across two archive days; the archive succeeding while LEAD_SIGHTINGS
 * fails; and the erasure ledger being written so a later gate run can subtract
 * it.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { eraseSubject, ssnSpellings, rowsAffected } from '../archive-erasure'
import type { Env } from '../../index'
import type { SnowflakeStatementResponse } from '../snowflake'

const env = { SSN_HASH_PEPPER: 'test-pepper' } as unknown as Env
const SSN = '123-45-6789'

const REQUEST = {
  ssn: SSN,
  reason: 'subject request 2026-08-22',
  organizationId: 'org-1',
  requestedBy: 'dan@trypennie.com',
}

interface Written { table: string; op: string; rows: unknown }

function supabaseDouble(opts: { auditDeleted?: number; auditError?: unknown } = {}) {
  const writes: Written[] = []
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {
        delete() { writes.push({ table, op: 'delete', rows: null }); return chain },
        upsert(rows: unknown) { writes.push({ table, op: 'upsert', rows }); return chain },
        eq() { return chain },
        in() { return chain },
        select() { return chain },
        then(res: (v: unknown) => unknown) {
          return Promise.resolve({
            data: Array.from({ length: opts.auditDeleted ?? 0 }, (_, i) => ({ id: `a-${i}` })),
            error: opts.auditError ?? null,
          }).then(res)
        },
      }
      return chain
    },
  } as unknown as SupabaseClient
  return { client, writes }
}

/** Snowflake answers: the resolve SELECT, then a row count per DELETE. */
function snowflakeDouble(opts: {
  resolved?: Array<[string, string]>
  deleted?: Record<string, number>
  failOn?: RegExp
} = {}) {
  const statements: string[] = []
  const query = async (statement: string): Promise<SnowflakeStatementResponse> => {
    statements.push(statement)
    if (opts.failOn?.test(statement)) throw new Error('warehouse suspended')
    if (statement.startsWith('SELECT DISTINCT')) {
      return { data: opts.resolved ?? [['e-1', '2026-08-20']] }
    }
    // Answers a DELETE's row count and a dry run's SELECT COUNT the same way,
    // from the same table name, so a test cannot assert against a double that
    // understands only one of the two forms (#823).
    const table = /(?:DELETE|SELECT COUNT\(\*\)) FROM (\S+)/.exec(statement)?.[1] ?? ''
    const key = table.split('.').pop()?.toLowerCase() ?? ''
    return { data: [[String(opts.deleted?.[key] ?? 1)]] }
  }
  return { statements, query }
}

describe('ssnSpellings', () => {
  it('matches both the way the engine writes it and the way the raw value looks', () => {
    // The two stores were not written by the same code path. Matching one
    // spelling would leave rows behind and still report an erasure.
    expect(ssnSpellings('123456789')).toEqual(['123456789', '123-45-6789'])
    expect(ssnSpellings('123-45-6789')).toEqual(['123456789', '123-45-6789'])
  })

  it('refuses anything that is not nine digits', () => {
    expect(() => ssnSpellings('12345')).toThrow(/nine digits/)
  })
})

describe('rowsAffected', () => {
  it('returns null when no count came back, never zero', () => {
    // "Deleted nothing" and "we cannot tell what happened" are different facts,
    // and reading the second as the first reports a store as clean that nobody
    // can vouch for (L90).
    expect(rowsAffected({ data: [['4']] })).toBe(4)
    expect(rowsAffected({})).toBeNull()
    expect(rowsAffected({ data: [['not a number']] })).toBeNull()
  })
})

describe('an erasure that finds the subject', () => {
  it('deletes from all four targets and reports each count separately', async () => {
    const db = supabaseDouble({ auditDeleted: 2 })
    const sf = snowflakeDouble({ deleted: { execution_archive: 3, lead_sightings: 1, lead_sighting_bids: 5 } })

    const result = await eraseSubject(env, db.client, REQUEST, { query: sf.query })

    expect(result.outcomes.map((o) => [o.target, o.rowsDeleted])).toEqual([
      ['execution_archive', 3],
      ['lead_sightings', 1],
      ['lead_sighting_bids', 5],
      ['audit_log', 2],
    ])
  })

  it('erases the sightings tables, not only the archive', async () => {
    // The rule from ADR 0009: erasing the archive without erasing
    // LEAD_SIGHTINGS is not erasure, because the SSN survives in the very table
    // used to find it.
    const db = supabaseDouble()
    const sf = snowflakeDouble()

    await eraseSubject(env, db.client, REQUEST, { query: sf.query })

    expect(sf.statements.some((s) => /DELETE FROM \S*LEAD_SIGHTINGS/.test(s))).toBe(true)
    expect(sf.statements.some((s) => /DELETE FROM \S*LEAD_SIGHTING_BIDS/.test(s))).toBe(true)
  })

  it('resolves from the sightings table AND the archive ssn_hash', async () => {
    // Together they cover an execution whose sighting row has been purged and
    // one whose payload carried no readable SSN.
    const db = supabaseDouble()
    const sf = snowflakeDouble()

    await eraseSubject(env, db.client, REQUEST, { query: sf.query })

    const resolve = sf.statements[0]
    expect(resolve).toMatch(/LEAD_SIGHTINGS WHERE ssn IN/)
    expect(resolve).toMatch(/ssn_hash = '/)
  })

  it('records the erasure so the deletion gate can subtract it', async () => {
    // Without the record the gate reports a shortfall it can never clear:
    // re-running the archiver re-inserts nothing, because the rows were
    // deliberately destroyed.
    const db = supabaseDouble()
    const sf = snowflakeDouble({ resolved: [['e-1', '2026-08-20'], ['e-2', '2026-08-20']] })

    await eraseSubject(env, db.client, REQUEST, { query: sf.query })

    const ledger = db.writes.find((w) => w.table === 'execution_archive_erasures')
    expect(ledger).toBeDefined()
    expect(ledger?.rows).toEqual([
      { execution_id: 'e-1', archive_day: '2026-08-20', reason: REQUEST.reason },
      { execution_id: 'e-2', archive_day: '2026-08-20', reason: REQUEST.reason },
    ])
  })

  it('does not call it an erasure while a target is unverified', async () => {
    // Logpush cannot be checked with any credential this codebase can reach, so
    // the response names it rather than closing the matter on the subject's
    // behalf.
    const db = supabaseDouble()
    const sf = snowflakeDouble()

    const result = await eraseSubject(env, db.client, REQUEST, { query: sf.query })

    expect(result.verdict.status).toBe('incomplete-coverage')
    expect(result.summary).toMatch(/NOT COMPLETE/)
  })
})

describe('an erasure that matches nothing', () => {
  it('says no rows matched, and never reports success', async () => {
    const db = supabaseDouble()
    const sf = snowflakeDouble({
      resolved: [],
      deleted: { execution_archive: 0, lead_sightings: 0, lead_sighting_bids: 0 },
    })

    const result = await eraseSubject(env, db.client, REQUEST, { query: sf.query })

    expect(result.verdict.status).toBe('no-rows-matched')
    expect(result.summary).toMatch(/nothing was found to erase/)
  })

  it('still asks the sightings tables, because the archive is not the only place', async () => {
    // An execution can be gone from the archive and its sighting row still
    // present, so resolving nothing must not skip the other targets.
    const db = supabaseDouble()
    const sf = snowflakeDouble({ resolved: [], deleted: { lead_sightings: 0, lead_sighting_bids: 0 } })

    await eraseSubject(env, db.client, REQUEST, { query: sf.query })

    expect(sf.statements.some((s) => /DELETE FROM \S*LEAD_SIGHTINGS/.test(s))).toBe(true)
  })
})

describe('an erasure where one store fails', () => {
  it('reports PARTIAL and names the store the identity survives in', async () => {
    const db = supabaseDouble()
    const sf = snowflakeDouble({ failOn: /DELETE FROM BIDSPOKE\.PUBLIC\.LEAD_SIGHTINGS/ })

    const result = await eraseSubject(env, db.client, REQUEST, { query: sf.query })

    expect(result.verdict.status).toBe('partial')
    expect(result.summary).toMatch(/^PARTIAL: lead_sightings failed/)
    expect(result.summary).toMatch(/is NOT an erasure/)
  })

  it('reports every target as unknown when the subject could not be resolved', async () => {
    // Reported as four failures rather than one, so the response cannot read as
    // "the archive was cleared and the rest matched nothing".
    const db = supabaseDouble()
    const sf = snowflakeDouble({ failOn: /SELECT DISTINCT/ })

    const result = await eraseSubject(env, db.client, REQUEST, { query: sf.query })

    expect(result.outcomes).toHaveLength(4)
    expect(result.outcomes.every((o) => o.error !== null)).toBe(true)
  })

  it('does not report a partial count for a target that failed midway', async () => {
    // "This much was removed" would read as progress when the truth is that the
    // target is in an unknown state.
    const db = supabaseDouble({ auditError: { message: 'gone' }, auditDeleted: 3 })
    const sf = snowflakeDouble()

    const result = await eraseSubject(env, db.client, REQUEST, { query: sf.query })
    const audit = result.outcomes.find((o) => o.target === 'audit_log')

    expect(audit?.rowsDeleted).toBeNull()
    expect(audit?.error).toBeTruthy()
  })
})

describe('a delete whose row count cannot be read', () => {
  it('is a failure, not a delete of zero rows', async () => {
    const db = supabaseDouble()
    const query = async (statement: string): Promise<SnowflakeStatementResponse> =>
      statement.startsWith('SELECT DISTINCT') ? { data: [['e-1', '2026-08-20']] } : { message: 'ok' }

    const result = await eraseSubject(env, db.client, REQUEST, { query })

    expect(result.verdict.status).toBe('partial')
    expect(result.outcomes[0].error).toMatch(/no readable row count/)
  })
})

// #823. Erasure DELETES (Dan, 2026-09-09), which makes a dry run the gate rather
// than a nicety: this is production consumer data with no undo. The dry run must
// resolve the subject exactly as the real run does, report what it WOULD remove,
// and issue nothing destructive.
describe('eraseSubject dry run', () => {
  const DRY = { ...REQUEST, dryRun: true }

  it('issues no DELETE at all', async () => {
    const sf = snowflakeDouble({ deleted: { execution_archive: 3, lead_sightings: 2, lead_sighting_bids: 5 } })
    await eraseSubject(env, supabaseDouble().client, DRY, { query: sf.query })
    expect(sf.statements.filter((s) => /^\s*DELETE/i.test(s))).toEqual([])
  })

  it('counts through the same predicate the real run would delete through', async () => {
    const sf = snowflakeDouble({})
    await eraseSubject(env, supabaseDouble().client, DRY, { query: sf.query })
    const counts = sf.statements.filter((s) => /^SELECT COUNT/i.test(s))
    // One per Snowflake target: the archive, sightings, bids.
    expect(counts.length).toBeGreaterThanOrEqual(3)
    expect(counts.some((s) => s.includes('LEAD_SIGHTINGS') && s.includes("'123-45-6789'"))).toBe(true)
  })

  it('reports what it would remove, per target', async () => {
    const sf = snowflakeDouble({ deleted: { execution_archive: 3, lead_sightings: 2, lead_sighting_bids: 5 } })
    const r = await eraseSubject(env, supabaseDouble({ auditDeleted: 4 }).client, DRY, { query: sf.query })
    const by = Object.fromEntries(r.outcomes.map((o) => [o.target, o.rowsDeleted]))
    expect(by.execution_archive).toBe(3)
    expect(by.lead_sightings).toBe(2)
    expect(by.lead_sighting_bids).toBe(5)
  })

  // A dry run that recorded an erasure would make the archive gate subtract rows
  // that are still there, and nothing would ever put them back.
  it('writes no erasure record and deletes no audit rows', async () => {
    const db = supabaseDouble({ auditDeleted: 4 })
    await eraseSubject(env, db.client, DRY, { query: snowflakeDouble({}).query })
    expect(db.writes.filter((w) => w.op === 'delete')).toEqual([])
    expect(db.writes.filter((w) => w.op === 'upsert')).toEqual([])
  })

  it('says in its summary that nothing was removed', async () => {
    const r = await eraseSubject(env, supabaseDouble().client, DRY, { query: snowflakeDouble({}).query })
    expect(r.summary.toLowerCase()).toContain('dry run')
  })

  // The failure this whole issue exists to prevent: a run that could not resolve
  // the subject must not read as "nothing to erase".
  it('reports every target as unknown when the subject cannot be resolved', async () => {
    const sf = snowflakeDouble({ failOn: /SELECT DISTINCT/ })
    const r = await eraseSubject(env, supabaseDouble().client, DRY, { query: sf.query })
    expect(r.outcomes.every((o) => o.rowsDeleted === null)).toBe(true)
    expect(r.outcomes.every((o) => o.error !== null)).toBe(true)
  })

  it('a real run still deletes, so the flag defaults off', async () => {
    const sf = snowflakeDouble({})
    await eraseSubject(env, supabaseDouble().client, REQUEST, { query: sf.query })
    expect(sf.statements.some((s) => /^\s*DELETE/i.test(s))).toBe(true)
  })
})

