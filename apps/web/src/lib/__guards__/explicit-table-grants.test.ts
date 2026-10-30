/**
 * Every new public table carries its own GRANT to service_role (#3097).
 *
 * From 2026-10-30 Supabase stops giving a new public table to anon,
 * authenticated and service_role through the default privileges of postgres
 * (https://github.com/orgs/supabase/discussions/45329). Tables that already
 * exist keep their grants; a table created after the change gets none, so the
 * Worker's first read of it fails with 42501 permission denied, service_role's
 * included. Nothing in review or CI saw that until this guard: the migration
 * reads correctly and the SQL suite's bootstrap copied the old defaults.
 *
 * So every CREATE TABLE of a public table needs a GRANT naming it to
 * service_role in the same migration:
 *   - bidding (supabase/migrations): every migration at or after the cutover,
 *     the version scripts/sql-suite/default-grants-cutover.sql names, which is
 *     also where the SQL suite takes the defaults away (one home for the date);
 *   - ops (supabase-ops/supabase/migrations): every migration. Its first one
 *     already took the defaults away from the browser roles, and each table since
 *     has been granted to service_role explicitly, so it is held to that.
 *
 * Partitions and temporary tables are left out: a partition is read through its
 * parent, whose grant governs, and a temporary table does not outlive its
 * session. Dynamic DDL inside a string (a partition maker's format()) is not
 * read as a table being created, the way _migration-tables.ts reads it.
 *
 * Seen red on the fixtures below (a table with no grant, a grant to another
 * role, a grant inside a comment, a grant to another table) and green with a
 * real grant; also seen red by deleting the service_role grant from an ops
 * migration.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '@/lib/__tests__/_scan-utils'
import { publicTablesWithoutServiceRoleGrant, tablesCreatedBy } from '@/lib/__tests__/_migration-tables'

const BIDDING = path.join(REPO_ROOT, 'supabase/migrations')
const OPS = path.join(REPO_ROOT, 'supabase-ops/supabase/migrations')
const CUTOVER_FILE = path.join(REPO_ROOT, 'scripts/sql-suite/default-grants-cutover.sql')

function cutoverVersion(): string {
  const m = /^-- cutover-before-migration: (\d{14})$/m.exec(readFileSync(CUTOVER_FILE, 'utf8'))
  if (!m) throw new Error(`${path.relative(REPO_ROOT, CUTOVER_FILE)} names no "-- cutover-before-migration: <14 digit version>" line`)
  return m[1]
}

function migrations(dir: string): Array<{ name: string; sql: string }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(dir, name), 'utf8') }))
}

function ungranted(files: Array<{ name: string; sql: string }>): string[] {
  return files.flatMap(({ name, sql }) => publicTablesWithoutServiceRoleGrant(sql).map((t) => `${name}: public.${t}`))
}

describe('the checker (#3097)', () => {
  it('flags a public table created with no grant', () => {
    expect(publicTablesWithoutServiceRoleGrant('CREATE TABLE public.widgets (id uuid PRIMARY KEY);')).toEqual(['widgets'])
  })

  it('passes the same table once it is granted to service_role', () => {
    const sql = 'CREATE TABLE public.widgets (id uuid PRIMARY KEY);\nGRANT SELECT, INSERT ON TABLE public.widgets TO service_role;'
    expect(publicTablesWithoutServiceRoleGrant(sql)).toEqual([])
  })

  it('reads an unqualified name as public, and a grant in a list or to several roles', () => {
    const sql = [
      'CREATE TABLE IF NOT EXISTS widgets (id int);',
      'CREATE UNLOGGED TABLE "public"."Gadgets" (id int);',
      'GRANT SELECT ON public.widgets, public.gadgets\n  TO authenticated, service_role;',
    ].join('\n')
    expect(publicTablesWithoutServiceRoleGrant(sql)).toEqual([])
  })

  it('accepts a grant on every table in public', () => {
    const sql = 'CREATE TABLE public.widgets (id int);\nGRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;'
    expect(publicTablesWithoutServiceRoleGrant(sql)).toEqual([])
  })

  it('refuses a grant to another role only', () => {
    const sql = 'CREATE TABLE public.widgets (id int);\nGRANT SELECT ON public.widgets TO authenticated;'
    expect(publicTablesWithoutServiceRoleGrant(sql)).toEqual(['widgets'])
  })

  it('refuses a grant that sits in a comment', () => {
    const sql = 'CREATE TABLE public.widgets (id int);\n-- GRANT SELECT ON public.widgets TO service_role;\n/* GRANT SELECT ON public.widgets TO service_role; */'
    expect(publicTablesWithoutServiceRoleGrant(sql)).toEqual(['widgets'])
  })

  it('refuses a grant on another table, a sequence or a function of the same name', () => {
    const sql = [
      'CREATE TABLE public.widgets (id int);',
      'GRANT SELECT ON public.widgets_archive TO service_role;',
      'GRANT USAGE ON SEQUENCE public.widgets TO service_role;',
      'GRANT EXECUTE ON FUNCTION public.widgets() TO service_role;',
    ].join('\n')
    expect(publicTablesWithoutServiceRoleGrant(sql)).toEqual(['widgets'])
  })

  it('does not let one grant statement run on into the next statement', () => {
    const sql = 'CREATE TABLE public.widgets (id int);\nGRANT SELECT ON public.widgets TO anon;\nGRANT SELECT ON public.other TO service_role;'
    expect(publicTablesWithoutServiceRoleGrant(sql)).toEqual(['widgets'])
  })

  it('leaves out partitions, temporary tables, other schemas and DDL built inside a string', () => {
    const sql = [
      'CREATE TABLE public.events_2026_10 PARTITION OF public.events FOR VALUES FROM (1) TO (2);',
      'CREATE TEMP TABLE scratch (id int);',
      'CREATE TABLE porting.inventory (id int);',
      "EXECUTE format('CREATE TABLE public.%I (id int)', v_name);",
    ].join('\n')
    expect(publicTablesWithoutServiceRoleGrant(sql)).toEqual([])
  })
})

describe('new public tables are granted explicitly (#3097)', () => {
  it('reads a cutover version from the SQL suite cutover file, and it is the platform change date', () => {
    expect(cutoverVersion()).toBe('20261030000000')
  })

  it('finds the tables the real migrations create, so a pass is not a blind parser', () => {
    // L98: a scan that finds nothing to check must not read as a pass.
    expect(tablesCreatedBy(migrations(BIDDING)).size).toBeGreaterThan(50)
    expect(tablesCreatedBy(migrations(OPS)).size).toBeGreaterThan(20)
    // And the checker sees the real shape: before the cutover, bidding relied on
    // the platform's default grants, so it flags many of those tables.
    const before = migrations(BIDDING).filter((m) => m.name < cutoverVersion())
    expect(ungranted(before).length).toBeGreaterThan(20)
  })

  it('every bidding migration at or after the cutover grants each public table it creates to service_role', () => {
    const after = migrations(BIDDING).filter((m) => m.name >= cutoverVersion())
    expect(ungranted(after)).toEqual([])
  })

  it('every ops migration grants each public table it creates to service_role', () => {
    const files = migrations(OPS)
    expect(files.length).toBeGreaterThan(20)
    expect(ungranted(files)).toEqual([])
  })
})
