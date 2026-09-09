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
import { ERASURE_TARGETS } from '../../archive/erasure'
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
          // Only audit_log answers with rows here. The Postgres sightings tables
          // are a different path with a different shape, and answering them with
          // audit-shaped rows made this fixture mean something nobody chose
          // (pgDouble is what exercises them).
          const isAudit = table === 'audit_log'
          return Promise.resolve({
            data: isAudit
              ? Array.from({ length: opts.auditDeleted ?? 0 }, (_, i) => ({ id: `a-${i}` }))
              : [],
            error: isAudit ? (opts.auditError ?? null) : null,
          }).then(res)
        },
      }
      return chain
    },
  } as unknown as SupabaseClient
  return { client, writes }
}

interface PgQuery { table: string; op: string; filters: unknown[] }

/**
 * Records every table, operation and filter the Postgres path builds, so the
 * assertions are about the statements actually issued rather than about which
 * functions were called.
 */
function pgDouble(opts: {
  sightings?: Array<{ id: string; execution_started_at_utc: string }>
  bids?: Array<{ id: string; attempted_at_utc: string }>
  resolveError?: { message: string } | null
} = {}) {
  const queries: PgQuery[] = []
  const client = {
    from(table: string) {
      const q: PgQuery = { table, op: 'select', filters: [] }
      queries.push(q)
      const chain: Record<string, unknown> = {
        select() { return chain },
        delete() { q.op = 'delete'; return chain },
        upsert(rows: unknown) { q.op = 'upsert'; q.filters.push(rows); return chain },
        in(col: string, vals: unknown) { q.filters.push(['in', col, vals]); return chain },
        eq(col: string, v: unknown) { q.filters.push(['eq', col, v]); return chain },
        gte(col: string, v: unknown) { q.filters.push(['gte', col, v]); return chain },
        lte(col: string, v: unknown) { q.filters.push(['lte', col, v]); return chain },
        then(res: (v: unknown) => unknown) {
          const err = opts.resolveError ?? null
          let data: unknown[] = []
          if (err === null) {
            if (table === 'lead_sightings') data = opts.sightings ?? []
            else if (table === 'lead_sighting_bids') data = opts.bids ?? [{ id: 'b-1', attempted_at_utc: '2026-09-01T00:05:00Z' }]
          }
          return Promise.resolve({ data, error: err }).then(res)
        },
      }
      return chain
    },
  } as unknown as SupabaseClient
  return { client, queries }
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
  it('deletes from every target and reports each count separately', async () => {
    const db = supabaseDouble({ auditDeleted: 2 })
    const sf = snowflakeDouble({ deleted: { execution_archive: 3, lead_sightings: 1, lead_sighting_bids: 5 } })

    const result = await eraseSubject(env, db.client, REQUEST, { query: sf.query })

    // The Postgres pair report zero here because supabaseDouble resolves no
    // sightings, which is the honest answer for this fixture rather than a gap.
    expect(result.outcomes.map((o) => [o.target, o.rowsDeleted])).toEqual([
      ['execution_archive', 3],
      ['lead_sightings', 1],
      ['lead_sighting_bids', 5],
      ['pg_lead_sighting_bids', 0],
      ['pg_lead_sightings', 0],
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

    // Derived from the target list rather than a literal, so adding a target
    // cannot leave this asserting about a subset of them (L96).
    expect(result.outcomes).toHaveLength(ERASURE_TARGETS.length)
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

// #823. The Snowflake copies were always covered; the POSTGRES partitioned
// tables of the same names were not. They are reached differently: sightings by
// the indexed `ssn`, and bids by `sighting_id`, because bids has no ssn index
// and an ssn scan there would cross every partition.
describe('eraseSubject over the Postgres sightings tables', () => {
  it('resolves the subject in Postgres by ssn, matching both spellings', async () => {
    const db = pgDouble({ sightings: [{ id: 's-1', execution_started_at_utc: '2026-09-01T00:00:00Z' }] })
    await eraseSubject(env, db.client, REQUEST, { query: snowflakeDouble({}).query })
    const q = db.queries.find((x) => x.table === 'lead_sightings' && x.op === 'select')
    expect(q?.filters).toContainEqual(['in', 'ssn', ['123456789', '123-45-6789']])
  })

  it('deletes the bids by sighting_id, not by ssn', async () => {
    const db = pgDouble({ sightings: [{ id: 's-1', execution_started_at_utc: '2026-09-01T00:00:00Z' }] })
    await eraseSubject(env, db.client, REQUEST, { query: snowflakeDouble({}).query })
    const del = db.queries.find((x) => x.table === 'lead_sighting_bids' && x.op === 'delete')
    expect(JSON.stringify(del?.filters)).toContain('sighting_id')
    expect(JSON.stringify(del?.filters)).not.toContain('"ssn"')
  })

  // The issue is explicit: without one, a single erasure scans all partitions.
  it('carries a partition-key predicate on every Postgres statement', async () => {
    const db = pgDouble({ sightings: [{ id: 's-1', execution_started_at_utc: '2026-09-01T00:00:00Z' }] })
    await eraseSubject(env, db.client, REQUEST, { query: snowflakeDouble({}).query })
    const sight = db.queries.find((x) => x.table === 'lead_sightings' && x.op === 'delete')
    const bids = db.queries.find((x) => x.table === 'lead_sighting_bids' && x.op === 'delete')
    expect(JSON.stringify(sight?.filters)).toContain('execution_started_at_utc')
    expect(JSON.stringify(bids?.filters)).toContain('attempted_at_utc')
  })

  it('deletes the bids before the sightings they hang off', async () => {
    const db = pgDouble({ sightings: [{ id: 's-1', execution_started_at_utc: '2026-09-01T00:00:00Z' }] })
    await eraseSubject(env, db.client, REQUEST, { query: snowflakeDouble({}).query })
    const order = db.queries.filter((x) => x.op === 'delete').map((x) => x.table)
    expect(order.indexOf('lead_sighting_bids')).toBeLessThan(order.indexOf('lead_sightings'))
  })

  it('reports both Postgres targets as their own outcomes', async () => {
    const db = pgDouble({ sightings: [{ id: 's-1', execution_started_at_utc: '2026-09-01T00:00:00Z' }] })
    const r = await eraseSubject(env, db.client, REQUEST, { query: snowflakeDouble({}).query })
    const names = r.outcomes.map((o) => o.target)
    expect(names).toContain('pg_lead_sightings')
    expect(names).toContain('pg_lead_sighting_bids')
  })

  it('finding no Postgres rows is zero, not a failure', async () => {
    const db = pgDouble({ sightings: [] })
    const r = await eraseSubject(env, db.client, REQUEST, { query: snowflakeDouble({}).query })
    const pg = r.outcomes.filter((o) => o.target.startsWith('pg_'))
    expect(pg.every((o) => o.rowsDeleted === 0 && o.error === null)).toBe(true)
  })

  it('a failed Postgres resolve reports unknown rather than zero', async () => {
    const db = pgDouble({ sightings: [], resolveError: { message: 'statement timeout' } })
    const r = await eraseSubject(env, db.client, REQUEST, { query: snowflakeDouble({}).query })
    const pg = r.outcomes.filter((o) => o.target.startsWith('pg_'))
    expect(pg.every((o) => o.rowsDeleted === null && o.error !== null)).toBe(true)
  })

  it('a dry run issues no Postgres delete', async () => {
    const db = pgDouble({ sightings: [{ id: 's-1', execution_started_at_utc: '2026-09-01T00:00:00Z' }] })
    await eraseSubject(env, db.client, { ...REQUEST, dryRun: true }, { query: snowflakeDouble({}).query })
    expect(db.queries.filter((x) => x.op === 'delete')).toEqual([])
  })
})
