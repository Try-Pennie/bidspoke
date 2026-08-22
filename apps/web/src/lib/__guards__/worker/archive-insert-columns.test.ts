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
  // Anchored on the closing paren of the column list, NOT on COMMENT following
  // it immediately. Snowflake allows table properties between the two, and the
  // first one added (DATA_RETENTION_TIME_IN_DAYS, #909) broke a version of this
  // regex that required them to be adjacent. The statement is still bounded by
  // its own terminating semicolon, so a match cannot run on into the roles and
  // grants further down the file (L135).
  // SQL comments are dropped before the statement is bounded, because the
  // terminator search is for a real `;` and prose contains them: the first
  // version of this looked for the first semicolon after the column list and
  // found one inside a comment explaining the retention setting, which reads as
  // "this is not the statement I meant" rather than as a parsing problem.
  const code = sql.replace(/^\s*--.*$/gm, '')
  const statement = /CREATE TABLE IF NOT EXISTS execution_archive \(([\s\S]*?)\n\)([\s\S]*?);/.exec(code)
  if (!statement) throw new Error('could not find the execution_archive CREATE TABLE, so this guard would pass vacuously')
  if (!/\bCOMMENT\s*=/.test(statement[2])) {
    throw new Error('found a CREATE TABLE for execution_archive with no COMMENT, so this is probably not the statement this guard means')
  }
  const columns: Column[] = []
  for (const raw of statement[1].split('\n')) {
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

  // The declared value the runtime read-back (#980) will compare the live table
  // against. Asserted here so the number in the DDL is load bearing rather than
  // prose: the guarantee on #909 is a 30 day undo window, and a script that
  // recreated this table at the 1 day default would satisfy every other check in
  // this file.
  it('declares the 30 day undo window, on the CREATE and on a re-runnable ALTER', () => {
    const sql = readFileSync(DDL, 'utf8').replace(/^\s*--.*$/gm, '')

    // Scoped to the CREATE's own property section, NOT searched over the whole
    // file. A file-wide search for the retention is answered by the ALTER below,
    // so both assertions would be satisfied by one line and neither half would
    // be checked (L178). Verified by deleting the clause from the CREATE and
    // watching this fail.
    const create = /CREATE TABLE IF NOT EXISTS execution_archive \([\s\S]*?\n\)([\s\S]*?);/.exec(sql)
    expect(create, 'no execution_archive CREATE TABLE, so this would pass vacuously').not.toBeNull()
    expect(create![1]).toMatch(/DATA_RETENTION_TIME_IN_DAYS\s*=\s*30/)

    // Both, deliberately. CREATE TABLE IF NOT EXISTS does nothing to a table
    // that already exists, so on every run after the first the clause on the
    // CREATE is inert and the ALTER is the only line putting the window in
    // force (#909).
    expect(sql).toMatch(/ALTER TABLE execution_archive SET DATA_RETENTION_TIME_IN_DAYS\s*=\s*30/)
  })

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
