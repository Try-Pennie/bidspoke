/**
 * Which workflows use a connection is asked in one place (#2946, L613):
 * readConnectionReferences in apps/worker/src/lib/connection-references.ts,
 * the one call of connection_references, the database function that answers
 * by definition_connection_ids, the predicate the workflow write check and the
 * Remove refusal read too.
 *
 * Before it, the Connections route called the function twice by hand (the Used
 * by list and Replace), and the daily owner and HTTP connection host checks did
 * not call it at all: they matched the connection's id against each
 * definition's text (definitionNames), so an alert could name a workflow the
 * page did not, or miss one it did. This fails on any other call of the
 * function in Worker source, so the next caller takes the shared read, and with
 * it the one rule.
 *
 * Seen red on 2026-10-28 against the two hand written calls left in
 * routes/api/connections.ts, and against the planted call in the last test.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WORKER_SRC, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

const HOME = 'lib/connection-references.ts'

/** A call of the function by its name, in any quote style; a comment naming it is not a call. */
const CALL = /\.rpc\(\s*(['"`])connection_references\1/g

export function callsOfConnectionReferences(source: string): number {
  return [...sanitizeSource(source, { blankStrings: false }).matchAll(CALL)].length
}

const rel = (full: string) => path.relative(WORKER_SRC, full).replace(/\\/g, '/')

const calls = listTsFiles(WORKER_SRC)
  .map((full) => ({ rel: rel(full), n: callsOfConnectionReferences(readFileSync(full, 'utf8')) }))
  // Tests answer the function in their Supabase doubles, which is not a read.
  .filter((f) => !`/${f.rel}`.includes('/__tests__/') && f.n > 0)

describe('connection_references is called only through readConnectionReferences (#2946)', () => {
  it('finds the one call in its home, so it cannot pass by matching nothing', () => {
    expect(calls.find((f) => f.rel === HOME)?.n).toBe(1)
  })

  it('no other Worker source calls it', () => {
    expect(calls.filter((f) => f.rel !== HOME).map((f) => f.rel)).toEqual([])
  })

  it('catches a planted call in each spelling, and not a comment or a log field naming it', () => {
    expect(callsOfConnectionReferences(`const { data } = await supabase.rpc('connection_references', { p_organization_id: o, p_connection_id: c })`)).toBe(1)
    expect(callsOfConnectionReferences('await supabase.rpc("connection_references", args)')).toBe(1)
    expect(callsOfConnectionReferences('await supabase\n  .rpc(`connection_references`, args)')).toBe(1)
    expect(callsOfConnectionReferences(`// asks connection_references through readConnectionReferences\nconst refs = await readConnectionReferences(supabase, o, c)`)).toBe(0)
    expect(callsOfConnectionReferences(`console.error(JSON.stringify({ what: 'connection_references' }))`)).toBe(0)
  })
})
