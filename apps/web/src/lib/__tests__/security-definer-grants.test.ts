/**
 * Issue #762. Postgres grants EXECUTE to PUBLIC by default on every new
 * function, so a SECURITY DEFINER function is callable by `anon` over
 * /rest/v1/rpc unless its migration explicitly revokes that. Measured on prod
 * 2026-08-13: an anonymous request carrying only the public anon key got HTTP
 * 200 from /rest/v1/rpc/user_org_id.
 *
 * The trap is that the omission is invisible in review. There is no wrong line
 * to spot, only a REVOKE that is absent, and 20260813000001 shipped a comment
 * stating anon was excluded while measurement showed it was not (LESSONS L124).
 *
 * So the guard reads the migrations rather than anybody's memory. SQL comments
 * are stripped first: several of these migrations discuss PUBLIC and anon in
 * prose, and a guard that is satisfied by a comment ABOUT the rule is
 * indistinguishable from one that works (LESSONS L103).
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './_scan-utils'

const MIGRATIONS = path.join(REPO_ROOT, 'supabase/migrations')

/**
 * Functions that predate this guard and are still reachable by anon. Tracked in
 * #762, which must close by emptying this list. An entry here is a KNOWN hole,
 * not an exemption: a deliberately inactive guard with no issue attached is
 * indistinguishable from no guard (LESSONS L65).
 */
const KNOWN_UNREVOKED_SEE_762 = new Set([
  // Writers, REST-callable, bypass RLS. The reason #762 is p0.
  'finalize_unrecoverable_stranded',
  'reduce_finalize_stranded',
  // Read-only, REST-callable. Careful: likely referenced by RLS policies, so it
  // must keep EXECUTE for `authenticated` when it is locked down.
  'user_org_id',
  // Trigger functions. Not REST-callable, so lower risk.
  'handle_new_auth_user',
  'handle_auth_user_updated',
  // NOTE: `rls_auto_enable` is also unrevoked in the live database but no
  // migration in this repo creates it, so this guard is structurally unable to
  // see it. It is recorded in #762 from the live privilege query instead. That
  // asymmetry is the point of LESSONS L96: a guard driven by what the repo
  // happens to list is blind to whatever is missing from the repo.
])

/** Blank SQL comments, preserving offsets so nothing shifts. */
function stripSqlComments(sql: string): string {
  const out = sql.split('')
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  while (i < sql.length) {
    if (sql[i] === '-' && sql[i + 1] === '-') {
      let j = i + 2
      while (j < sql.length && sql[j] !== '\n') j++
      blank(i, j)
      i = j
    } else if (sql[i] === '/' && sql[i + 1] === '*') {
      let j = i + 2
      while (j < sql.length && !(sql[j] === '*' && sql[j + 1] === '/')) j++
      blank(i, j + 2)
      i = j + 2
    } else {
      i++
    }
  }
  return out.join('')
}

function allMigrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => stripSqlComments(readFileSync(path.join(MIGRATIONS, f), 'utf8')))
    .join('\n')
}

/** Names of every `public` function any migration creates as SECURITY DEFINER. */
function securityDefinerFunctions(sql: string): Set<string> {
  const names = new Set<string>()
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\(/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql))) {
    // The body runs to the next CREATE FUNCTION or the end of the corpus.
    const rest = sql.slice(m.index)
    const nextIdx = rest.slice(1).search(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s/i)
    const body = nextIdx === -1 ? rest : rest.slice(0, nextIdx + 1)
    if (/SECURITY\s+DEFINER/i.test(body)) names.add(m[1])
  }
  return names
}

/** Names some migration later drops, so they no longer exist to be called. */
function droppedFunctions(sql: string): Set<string> {
  const names = new Set<string>()
  const re = /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:public\.)?(\w+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql))) names.add(m[1])
  return names
}

/** Names with an explicit REVOKE of PUBLIC (or anon) EXECUTE somewhere. */
function revokedFunctions(sql: string): Set<string> {
  const names = new Set<string>()
  const re = /REVOKE\s+[\s\S]{0,40}?\s+ON\s+FUNCTION\s+(?:public\.)?(\w+)\s*\([^)]*\)\s+FROM\s+(PUBLIC|anon)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql))) names.add(m[1])
  return names
}

/** Created as SECURITY DEFINER and never dropped, so still callable today. */
function liveSecurityDefinerFunctions(sql: string): Set<string> {
  const dropped = droppedFunctions(sql)
  return new Set([...securityDefinerFunctions(sql)].filter((n) => !dropped.has(n)))
}

describe('security-definer functions are not left callable by anon (#762)', () => {
  const sql = allMigrationSql()

  it('finds the security-definer functions at all, so the guard cannot pass vacuously', () => {
    const found = securityDefinerFunctions(sql)
    expect(found.size).toBeGreaterThan(5)
    expect(found).toContain('is_allowlisted')
    expect(found).toContain('auth_user_with_allowlist')
  })

  it('strips SQL comments, so prose about PUBLIC cannot satisfy the rule', () => {
    const commentOnly = '-- REVOKE ALL ON FUNCTION public.faker() FROM PUBLIC\n'
    expect(revokedFunctions(stripSqlComments(commentOnly)).has('faker')).toBe(false)
    const real = 'REVOKE ALL ON FUNCTION public.faker() FROM PUBLIC;\n'
    expect(revokedFunctions(stripSqlComments(real)).has('faker')).toBe(true)
  })

  it('revokes PUBLIC execute on every security-definer function that still exists', () => {
    const live = liveSecurityDefinerFunctions(sql)
    const revoked = revokedFunctions(sql)
    const unprotected = [...live].filter(
      (n) => !revoked.has(n) && !KNOWN_UNREVOKED_SEE_762.has(n),
    )
    expect(unprotected).toEqual([])
  })

  it('keeps the known-hole list honest: every name on it is still a live function', () => {
    // An entry that no longer names a live function is stale and hides the
    // list's shrinking, so #762's completion stays measurable.
    const live = liveSecurityDefinerFunctions(sql)
    const stale = [...KNOWN_UNREVOKED_SEE_762].filter((n) => !live.has(n))
    expect(stale).toEqual([])
  })
})
