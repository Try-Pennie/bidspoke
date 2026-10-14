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

function supabaseDouble(opts: { auditDeleted?: number; auditError?: unknown; writebackDeleted?: number } = {}) {
  const writes: Written[] = []
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {
        delete() { writes.push({ table, op: 'delete', rows: null }); return chain },
        upsert(rows: unknown) { writes.push({ table, op: 'upsert', rows }); return chain },
        eq() { return chain },
        in() { return chain },
        select() { return chain },
        // The Postgres resolve reads through fetchAllPaged, so the chain has to
        // answer these even though this double resolves no sightings.
        order() { return chain },
        range() { return chain },
        then(res: (v: unknown) => unknown) {
          // Only audit_log answers with rows here. The Postgres sightings tables
          // are a different path with a different shape, and answering them with
          // audit-shaped rows made this fixture mean something nobody chose
          // (pgDouble is what exercises them).
          const isAudit = table === 'audit_log'
          // The failed writeback store (#1993) is erased by run id the same way.
          if (table === 'outcome_writeback_deadletters') {
            return Promise.resolve({
              data: Array.from({ length: opts.writebackDeleted ?? 0 }, (_, i) => ({ id: `w-${i}` })),
              error: null,
            }).then(res)
          }
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
  sightings?: Array<{ id: string; execution_started_at_utc: string; execution_id?: string }>
  bids?: Array<{ id: string; attempted_at_utc: string }>
  /** Fails the sightings reads only, so the stores keyed by run id still answer. */
  resolveError?: { message: string } | null
  writebackRows?: number
  writebackError?: { message: string; code?: string }
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
        order(col: string) { q.filters.push(['order', col]); return chain },
        range(from: number, to: number) { q.filters.push(['range', from, to]); return chain },
        eq(col: string, v: unknown) { q.filters.push(['eq', col, v]); return chain },
        gte(col: string, v: unknown) { q.filters.push(['gte', col, v]); return chain },
        lte(col: string, v: unknown) { q.filters.push(['lte', col, v]); return chain },
        then(res: (v: unknown) => unknown) {
          const sightingsRead = table === 'lead_sightings' || table === 'lead_sighting_bids'
          const err = sightingsRead
            ? (opts.resolveError ?? null)
            : table === 'outcome_writeback_deadletters'
              ? (opts.writebackError ?? null)
              : null
          let data: unknown[] = []
          if (table === 'outcome_writeback_deadletters') {
            data = Array.from({ length: opts.writebackRows ?? 0 }, (_, i) => ({ id: `w-${i}` }))
          } else if (err === null) {
            // Answer the FIRST page only. fetchAllPaged keeps asking until a
            // short page comes back, so a double that returned the same rows
            // forever would spin rather than fail, which is the worse failure.
            const range = q.filters.find((f) => Array.isArray(f) && f[0] === 'range') as
              | [string, number, number]
              | undefined
            const firstPage = range === undefined || range[1] === 0
            if (firstPage) {
              if (table === 'lead_sightings') data = opts.sightings ?? []
              else if (table === 'lead_sighting_bids') data = opts.bids ?? [{ id: 'b-1', attempted_at_utc: '2026-09-01T00:05:00Z' }]
            }
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
  /** Every statement WITH the values it bound, so a test can assert on both halves. */
  const bound: Array<{ sql: string; bindings: unknown[] }> = []
  const query = async (statement: string, bindings?: unknown[]): Promise<SnowflakeStatementResponse> => {
    statements.push(statement)
    bound.push({ sql: statement, bindings: bindings ?? [] })
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
  return { statements, bound, query }
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
    const db = supabaseDouble({ auditDeleted: 2, writebackDeleted: 1 })
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
      // A failed Salesforce write held for replay carries the subject's lead
      // fields, encrypted, so it is erased with the rest (#1993).
      ['pg_outcome_writeback_deadletters', 1],
    ])
    expect(db.writes.some((w) => w.table === 'outcome_writeback_deadletters' && w.op === 'delete')).toBe(true)
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
    expect(resolve).toMatch(/ssn_hash = \?/)
  })

  it('never puts the subject’s SSN into the SQL text, on any statement', async () => {
    // The property, rather than the escaping that used to defend it (#1006).
    // This file DELETEs from three tables on a caller supplied value, and the
    // correctness of an escaped form rests on every future edit remembering to
    // call the helper. Binding removes the class.
    const db = supabaseDouble()
    const sf = snowflakeDouble()

    await eraseSubject(env, db.client, REQUEST, { query: sf.query })

    const digits = REQUEST.ssn.replace(/\D/g, '')
    for (const { sql } of sf.bound) {
      expect(sql, `the SSN reached the SQL text of: ${sql}`).not.toContain(digits)
      expect(sql).not.toContain(REQUEST.ssn)
    }
  })

  it('binds both spellings of the SSN as values', async () => {
    const db = supabaseDouble()
    const sf = snowflakeDouble()

    await eraseSubject(env, db.client, REQUEST, { query: sf.query })

    const digits = REQUEST.ssn.replace(/\D/g, '')
    const dashed = `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
    // Both spellings, because matching one would leave rows behind and still
    // report an erasure, which is the failure this phase exists to prevent.
    expect(sf.bound[0].bindings).toEqual(expect.arrayContaining([digits, dashed]))
  })

  it('binds one value per placeholder, on every statement it issues', async () => {
    // A count mismatch is the way a bound statement goes wrong, and it fails at
    // the warehouse rather than here, so it is worth asserting directly.
    const db = supabaseDouble()
    const sf = snowflakeDouble({ resolved: [['e-1', '2026-08-20'], ['e-2', '2026-08-21']] })

    await eraseSubject(env, db.client, REQUEST, { query: sf.query })

    for (const { sql, bindings } of sf.bound) {
      expect(sql.split('?').length - 1, `placeholders did not match bindings for: ${sql}`).toBe(
        bindings.length,
      )
    }
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
    // The point of a dry run is that it previews the REAL predicate, so this
    // compares the two rather than reading either one on its own. It used to
    // assert the SSN appeared in the COUNT's text, which stopped being possible
    // once the values were bound (#1006); the property it was after is stronger
    // when stated as an equality between the two runs.
    const preview = snowflakeDouble({})
    await eraseSubject(env, supabaseDouble().client, DRY, { query: preview.query })

    const real = snowflakeDouble({})
    await eraseSubject(env, supabaseDouble().client, REQUEST, { query: real.query })

    const previewed = preview.bound
      .filter((b) => /^SELECT COUNT/i.test(b.sql))
      .map((b) => ({ sql: b.sql.replace(/^SELECT COUNT\(\*\) /, ''), bindings: b.bindings }))
    const deleted = real.bound
      .filter((b) => /^DELETE/i.test(b.sql))
      .map((b) => ({ sql: b.sql.replace(/^DELETE /, ''), bindings: b.bindings }))

    // One per Snowflake target: the archive, sightings, bids.
    expect(previewed.length).toBeGreaterThanOrEqual(3)
    expect(previewed).toEqual(deleted)
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

  // #1993 review. A run whose archive row is gone but whose Postgres sighting
  // remains is found only here, and its failed writeback holds the subject's
  // lead fields, so the writeback erasure must reach it too.
  it('erases the failed writebacks of runs only the Postgres sightings know about', async () => {
    const db = pgDouble({ sightings: [{ id: 's-1', execution_started_at_utc: '2026-09-01T00:00:00Z', execution_id: 'e-pg' }], writebackRows: 2 })
    const r = await eraseSubject(env, db.client, REQUEST, { query: snowflakeDouble({ resolved: [['e-1', '2026-08-20']] }).query })
    const del = db.queries.find((x) => x.table === 'outcome_writeback_deadletters' && x.op === 'delete')
    const ids = (del?.filters.find((f) => Array.isArray(f) && f[0] === 'in' && f[1] === 'execution_id') as [string, string, string[]] | undefined)?.[2]
    expect([...(ids ?? [])].sort()).toEqual(['e-1', 'e-pg'])
    expect(r.outcomes.find((o) => o.target === 'pg_outcome_writeback_deadletters')).toEqual({ target: 'pg_outcome_writeback_deadletters', rowsDeleted: 2, error: null })
  })

  it('a dry run counts the failed writebacks it would erase, rather than reporting zero', async () => {
    const db = pgDouble({ sightings: [{ id: 's-1', execution_started_at_utc: '2026-09-01T00:00:00Z', execution_id: 'e-pg' }], writebackRows: 3 })
    const r = await eraseSubject(env, db.client, { ...REQUEST, dryRun: true }, { query: snowflakeDouble({}).query })
    expect(r.outcomes.find((o) => o.target === 'pg_outcome_writeback_deadletters')?.rowsDeleted).toBe(3)
    expect(db.queries.filter((x) => x.table === 'outcome_writeback_deadletters' && x.op === 'delete')).toEqual([])
  })

  it('still erases the writebacks it can find when the Postgres sightings cannot be resolved, and says the rest are unknown', async () => {
    const db = pgDouble({ resolveError: { message: 'statement timeout' }, writebackRows: 1 })
    const r = await eraseSubject(env, db.client, REQUEST, { query: snowflakeDouble({ resolved: [['e-1', '2026-08-20']] }).query })
    expect(db.queries.some((x) => x.table === 'outcome_writeback_deadletters' && x.op === 'delete')).toBe(true)
    const w = r.outcomes.find((o) => o.target === 'pg_outcome_writeback_deadletters')
    expect(w?.rowsDeleted).toBeNull()
    expect(w?.error).toMatch(/1 .*removed.*could not be resolved/)
  })

  // #1993 review. The run ids are found through the archive and the sightings,
  // so the writebacks go FIRST: if their delete fails, the stores that name the
  // runs are kept, and a re-run can still find and finish them.
  it('erases the writebacks before the stores that name their runs, and keeps those stores when it fails', async () => {
    const db = pgDouble({
      sightings: [{ id: 's-1', execution_started_at_utc: '2026-09-01T00:00:00Z', execution_id: 'e-pg' }],
      writebackError: { message: 'statement timeout', code: '57014' },
    })
    const sf = snowflakeDouble({ resolved: [['e-1', '2026-08-20']] })
    const r = await eraseSubject(env, db.client, REQUEST, { query: sf.query })
    expect(sf.statements.filter((s) => /^DELETE/.test(s))).toEqual([])
    expect(db.queries.filter((x) => x.op === 'delete').map((x) => x.table)).toEqual(['outcome_writeback_deadletters'])
    const held = r.outcomes.filter((o) => o.target !== 'pg_outcome_writeback_deadletters')
    expect(held.every((o) => o.rowsDeleted === null && /kept so a re-run can find/.test(o.error ?? ''))).toBe(true)
    expect(r.verdict.status).toBe('partial')
  })

  it('erases the writebacks before any other store when it succeeds', async () => {
    const db = pgDouble({ sightings: [{ id: 's-1', execution_started_at_utc: '2026-09-01T00:00:00Z', execution_id: 'e-pg' }], writebackRows: 1 })
    await eraseSubject(env, db.client, REQUEST, { query: snowflakeDouble({}).query })
    expect(db.queries.filter((x) => x.op === 'delete').map((x) => x.table)[0]).toBe('outcome_writeback_deadletters')
  })

  it('a dry run issues no Postgres delete', async () => {
    const db = pgDouble({ sightings: [{ id: 's-1', execution_started_at_utc: '2026-09-01T00:00:00Z' }] })
    await eraseSubject(env, db.client, { ...REQUEST, dryRun: true }, { query: snowflakeDouble({}).query })
    expect(db.queries.filter((x) => x.op === 'delete')).toEqual([])
  })
})
