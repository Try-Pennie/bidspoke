// .github/scripts/db-privilege-check.mjs: the live database privilege check (#1709,
// plan 0.E). CI asks each Supabase project, through the Management API, for every
// object the browser roles (anon, authenticated) can reach that they should not,
// and fails naming each one.
//
//   SUPABASE_ACCESS_TOKEN=... MAIN_PROJECT_REF=... OPS_PROJECT_REF=... node .github/scripts/db-privilege-check.mjs
//
// Read only: each query goes to the read only endpoint and reads only the catalogue.
//
// The main project serves the browser, so anon and authenticated legitimately
// reach tables there; the rule is that every table or view they can reach has row
// level security, and that they reach nothing at all in the porting schema (#1710).
// The ops project serves no browser: anon and authenticated reach nothing in
// public, every table has RLS and an organization_id uuid NOT NULL column, and the
// default privileges of postgres in public grant them nothing (L124, L541, L18).
//
// Each rule returns one 'inspected' row with the number of objects it looked at,
// and one 'violation' row per problem. A rule that returns no inspected row has
// measured nothing and fails (L98). Any API failure fails, never reads as clean.

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BROWSER = "array['anon','authenticated']"

/** Objects in the given schemas that no extension owns. */
const ownRelations = (schemas, kinds) => `
  select c.oid, n.nspname || '.' || c.relname as name, c.relkind, c.relrowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in (${schemas}) and c.relkind in (${kinds})
    and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')`

export const RULES = {
  main: `
with rel as (${ownRelations("'public','porting'", "'r','p','v','m','f'")}),
v as (
  select name as object, 'reachable by ' || r || ' with row level security off' as problem
  from rel, unnest(${BROWSER}) r
  where not relrowsecurity and has_table_privilege(r, oid, 'SELECT,INSERT,UPDATE,DELETE')
    and name not like 'porting.%'
  union all
  select name, r || ' holds a privilege in the porting schema'
  from rel, unnest(${BROWSER}) r
  where name like 'porting.%' and has_table_privilege(r, oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  union all
  select 'schema porting', r || ' holds USAGE'
  from unnest(${BROWSER}) r
  where exists (select 1 from pg_namespace where nspname = 'porting') and has_schema_privilege(r, 'porting', 'USAGE')
)
select 'inspected' as kind, (select count(*) from rel)::text as object, null::text as problem
union all
select 'violation', object, problem from v`,

  ops: `
with rel as (${ownRelations("'public'", "'r','p','v','m','f','S'")}),
fn as (
  select p.oid, 'public.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as name
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
),
v as (
  select name as object, r || ' holds a privilege' as problem
  from rel, unnest(${BROWSER}) r
  where case when relkind = 'S' then has_sequence_privilege(r, oid, 'SELECT,USAGE,UPDATE')
             else has_table_privilege(r, oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') end
  union all
  select name, 'row level security is off' from rel where relkind in ('r','p') and not relrowsecurity
  union all
  select name, 'no organization_id uuid NOT NULL column' from rel
  where relkind in ('r','p') and not exists (
    select 1 from pg_attribute a
    where a.attrelid = rel.oid and a.attname = 'organization_id' and a.attnotnull
      and a.atttypid = 'uuid'::regtype and not a.attisdropped)
  union all
  select name, r || ' can execute it' from fn, unnest(${BROWSER}) r where has_function_privilege(r, oid, 'EXECUTE')
  union all
  select 'schema public', r || ' holds USAGE' from unnest(${BROWSER}) r where has_schema_privilege(r, 'public', 'USAGE')
  union all
  select 'default privileges of postgres in public', 'grant ' || e.privilege_type || ' on kind ' || d.defaclobjtype::text || ' to ' || coalesce(pg_get_userbyid(nullif(e.grantee, 0)), 'PUBLIC')
  from pg_default_acl d, aclexplode(d.defaclacl) e
  where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace
    and (e.grantee = 0 or pg_get_userbyid(e.grantee) in ('anon', 'authenticated'))
)
select 'inspected' as kind, ((select count(*) from rel) + (select count(*) from fn))::text as object, null::text as problem
union all
select 'violation', object, problem from v`,
}

/**
 * Runs one query on a project through the Management API's read only endpoint,
 * which runs it as supabase_read_only_user (measured working 2026-10-06 on both
 * projects; the catalogue functions used here need no table privilege).
 */
export async function queryProject(fetchFn, token, ref, sql) {
  const res = await fetchFn(`https://api.supabase.com/v1/projects/${ref}/database/query/read-only`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`project ${ref}: the query failed with ${res.status}: ${body.slice(0, 400)}`)
  }
  const rows = await res.json()
  if (!Array.isArray(rows)) throw new Error(`project ${ref}: the answer is not a list of rows`)
  return rows
}

/** The verdict for one project from its rule's rows. */
export function checkProject(label, rows) {
  const inspected = rows.filter((r) => r.kind === 'inspected')
  const violations = rows.filter((r) => r.kind === 'violation')
  const unknown = rows.filter((r) => r.kind !== 'inspected' && r.kind !== 'violation')
  if (inspected.length !== 1) {
    return { ok: false, lines: [`${label}: the rule returned no inspected count (${inspected.length} rows), so it measured nothing`] }
  }
  const lines = [`${label}: ${inspected[0].object} object(s) inspected, ${violations.length === 0 ? 'no violation' : `${violations.length} violation(s)`}`]
  for (const v of violations) lines.push(`  ${v.object}: ${v.problem}`)
  for (const u of unknown) lines.push(`  unknown row kind ${u.kind}: ${JSON.stringify(u)}`)
  return { ok: violations.length === 0 && unknown.length === 0, lines }
}

async function main() {
  const token = process.env.SUPABASE_ACCESS_TOKEN
  const refs = { main: process.env.MAIN_PROJECT_REF, ops: process.env.OPS_PROJECT_REF }
  const missing = ['SUPABASE_ACCESS_TOKEN', 'MAIN_PROJECT_REF', 'OPS_PROJECT_REF'].filter((k) => !process.env[k])
  if (missing.length > 0) {
    console.error(`db privilege check: ${missing.join(', ')} not set, so nothing was checked`)
    process.exit(1)
  }
  let ok = true
  for (const label of Object.keys(RULES)) {
    try {
      const verdict = checkProject(label, await queryProject(fetch, token, refs[label], RULES[label]))
      for (const line of verdict.lines) console.log(line)
      ok &&= verdict.ok
    } catch (err) {
      console.error(`${label}: ${err instanceof Error ? err.message : 'the check threw'}`)
      ok = false
    }
  }
  process.exit(ok ? 0 : 1)
}

// Run only as the entry script, compared as real paths, as scan-coverage.mjs does:
// a bare string compare against argv misses a relative path, and the check then
// exits 0 having checked nothing (L98); import.meta.url is percent encoded (L740).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
