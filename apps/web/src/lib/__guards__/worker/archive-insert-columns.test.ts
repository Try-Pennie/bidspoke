import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, WORKER_SRC } from '../../__tests__/_scan-utils'

/**
 * The archive INSERT must name exactly the columns the archive table declares (#871).
 *
 * The Snowflake table is created by a committed SQL file that a person runs by
 * hand against the account, so nothing in the build relates the two. That is the
 * whole gap: the INSERT named seven of twenty three columns, and three of the
 * omitted ones are NOT NULL with no default, so the first send after the
 * credentials were set would have failed on a constraint violation. No test
 * could have caught it, because every test builds the statement and none of them
 * can execute it.
 *
 * Checked in BOTH directions. A column the table requires and the INSERT omits
 * fails the send outright; a column the INSERT names and the table does not have
 * fails it just as hard, and a typo is the likeliest way to produce the second.
 *
 * Both sides are parsed from the artifacts that actually ship (the DDL file and
 * the worker source), never from a list restated here, which would be a third
 * definition free to agree with neither (L107).
 */
const DDL = path.join(REPO_ROOT, 'docs/snowflake-archive-setup.sql')
const SEND = path.join(WORKER_SRC, 'lib/execution-archive-send.ts')

interface Column {
  name: string
  notNull: boolean
  hasDefault: boolean
}

/**
 * Columns of execution_archive as the committed DDL declares them, scoped to
 * that one CREATE TABLE. The file also creates roles, grants and a second
 * database's objects, so a match found anywhere in it could otherwise answer for
 * this table (L135).
 */
function tableColumns(): Column[] {
  const sql = readFileSync(DDL, 'utf8')
  const match = /CREATE TABLE IF NOT EXISTS execution_archive \(([\s\S]*?)\n\)\s*\nCOMMENT/.exec(sql)
  if (!match) throw new Error('could not find the execution_archive CREATE TABLE, so this guard would pass vacuously')
  const columns: Column[] = []
  for (const raw of match[1].split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('--')) continue
    columns.push({
      name: line.split(/\s+/)[0],
      notNull: /NOT NULL/.test(line),
      hasDefault: /DEFAULT/.test(line),
    })
  }
  return columns
}

/**
 * Columns the INSERT writes, read out of the one map the statement is built
 * from. Reading the map rather than a hand-written list is what makes deleting
 * a column from the sender show up here.
 */
function insertColumns(): string[] {
  const src = readFileSync(SEND, 'utf8')
  const block = /const VALUE_OF[\s\S]*?=\s*\{([\s\S]*?)\n\}/.exec(src)
  if (!block) throw new Error('could not find VALUE_OF in execution-archive-send.ts, so this guard would pass vacuously')
  // Keys only: a nested arrow body may mention a column name, and the key is
  // the only thing that reaches the statement.
  return [...block[1].matchAll(/^ {2}([a-z0-9_]+):/gm)].map((m) => m[1])
}

describe('the archive INSERT against the table it writes into', () => {
  const columns = tableColumns()
  const required = columns.filter((c) => c.notNull && !c.hasDefault).map((c) => c.name)
  const written = insertColumns()

  it('found a real table and a real statement, so nothing below passes vacuously', () => {
    // Every count asserted separately: a regex that matched a fragment would
    // otherwise satisfy the two checks below by having almost nothing to
    // compare (L98).
    expect(columns.length).toBeGreaterThan(15)
    expect(required.length).toBeGreaterThan(3)
    expect(written.length).toBeGreaterThan(15)
  })

  it('writes every column the table requires', () => {
    const missing = required.filter((name) => !written.includes(name))
    expect(missing, 'these columns are NOT NULL with no default, so the send fails on them').toEqual([])
  })

  it('writes no column the table does not declare', () => {
    const names = columns.map((c) => c.name)
    const unknown = written.filter((name) => !names.includes(name))
    expect(unknown, 'these columns are not on the archive table, so the statement is rejected').toEqual([])
  })

  it('names each column once, since a repeat is a value silently dropped', () => {
    expect(written.length).toBe(new Set(written).size)
  })
})
