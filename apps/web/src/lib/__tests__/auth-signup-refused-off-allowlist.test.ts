/**
 * Issue #759. A non-allowlisted Google account must not end up holding a
 * credential at all.
 *
 * `handle_new_auth_user` correctly declined to PROVISION app records for an
 * email that is not on `user_allowlist` (20260623000001), but it did so by
 * returning NEW, so the `auth.users` row was still created and GoTrue still
 * issued a real `authenticated` JWT. Declining to provision is not declining to
 * authenticate: the stranger held the exact session key that every RLS policy
 * written against the `authenticated` role has to defend against, which is what
 * made #729 exploitable. Nothing pruned those rows either.
 *
 * The invariant asserted here: the non-allowlisted branch RAISES, aborting the
 * INSERT, so no auth row and no session can exist for an address nobody added.
 *
 * This is a text guard because the rule lives in a plpgsql function body and no
 * type system can see it. It strips SQL comments before matching, so a comment
 * describing the refusal cannot satisfy it (LESSONS L103), and it pins its own
 * matcher against both the old and new shapes so it cannot pass vacuously
 * (LESSONS L1).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './_scan-utils'

const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase/migrations')

/** Blank out SQL comments (-- to EOL, and /* *\/ blocks) while keeping line count. */
export function stripSqlComments(sql: string): string {
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

const migrationFiles = () =>
  readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()

/**
 * The comment-stripped body of the LAST migration that (re)defines a function.
 * Later migrations replace earlier ones, so only the final definition governs.
 */
function latestDefinitionOf(fnName: string): { file: string; body: string } {
  const needle = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(public\\.)?${fnName}\\b`,
    'i',
  )
  let found: { file: string; body: string } | null = null
  for (const file of migrationFiles()) {
    const sql = stripSqlComments(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))
    const m = needle.exec(sql)
    if (m) found = { file, body: sql.slice(m.index) }
  }
  if (!found) throw new Error(`no migration defines ${fnName}`)
  return found
}

/**
 * The allowlist gate is the block guarding on membership of user_allowlist.
 * Returns the text between that guard and the end of its IF, which is where the
 * decision to refuse or wave through is made.
 */
function allowlistGateBlock(body: string): string {
  const guard = /IF\s+NOT\s+EXISTS\s*\([\s\S]*?user_allowlist[\s\S]*?\)\s*THEN/i.exec(body)
  if (!guard) throw new Error('handle_new_auth_user has no user_allowlist guard at all')
  const after = body.slice(guard.index + guard[0].length)
  const end = /END\s+IF\s*;/i.exec(after)
  return after.slice(0, end ? end.index : after.length)
}

const REFUSES = /\bRAISE\s+(EXCEPTION|insufficient_privilege)/i
const WAVES_THROUGH = /\bRETURN\s+NEW\s*;/i

describe('a non-allowlisted signup is refused a credential, not merely unprovisioned (#759)', () => {
  it('raises on the non-allowlisted branch so the auth.users INSERT aborts', () => {
    const { body } = latestDefinitionOf('handle_new_auth_user')
    expect(REFUSES.test(allowlistGateBlock(body))).toBe(true)
  })

  it('does not simply return NEW on the non-allowlisted branch', () => {
    const { body } = latestDefinitionOf('handle_new_auth_user')
    expect(WAVES_THROUGH.test(allowlistGateBlock(body))).toBe(false)
  })

  it('detects the old wave-through shape, so the guard cannot pass vacuously', () => {
    const old = `
      IF NOT EXISTS (
        SELECT 1 FROM public.user_allowlist WHERE email = lower(NEW.email)
      ) THEN
        RETURN NEW;
      END IF;
    `
    const block = allowlistGateBlock(old)
    expect(WAVES_THROUGH.test(block)).toBe(true)
    expect(REFUSES.test(block)).toBe(false)
  })

  it('is not satisfied by a comment describing the refusal', () => {
    const commentedOnly = `
      IF NOT EXISTS (
        SELECT 1 FROM public.user_allowlist WHERE email = lower(NEW.email)
      ) THEN
        -- RAISE EXCEPTION would be the right thing here one day
        RETURN NEW;
      END IF;
    `
    const block = allowlistGateBlock(stripSqlComments(commentedOnly))
    expect(REFUSES.test(block)).toBe(false)
  })

  it('still has a user_allowlist guard at all, so a deleted gate fails loudly', () => {
    const { body } = latestDefinitionOf('handle_new_auth_user')
    expect(() => allowlistGateBlock(body)).not.toThrow()
  })
})

describe('orphan auth.users rows are pruned (#759)', () => {
  it('ships a prune keyed on the absence of a public.users row', () => {
    // Keyed on the missing app record, NOT on allowlist membership: one live
    // account (a pre-allowlist signup) has a users row while off the list, and
    // an allowlist-keyed prune would delete a real employee's account.
    const prune = migrationFiles()
      .map((f) => ({ f, sql: stripSqlComments(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')) }))
      .find(({ sql }) => /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(public\.)?prune_orphan_auth_users\b/i.test(sql))
    expect(prune, 'no migration defines prune_orphan_auth_users').toBeDefined()
    const sql = prune!.sql
    expect(/DELETE\s+FROM\s+auth\.users/i.test(sql)).toBe(true)
    expect(/NOT\s+EXISTS\s*\([\s\S]*?public\.users[\s\S]*?\)/i.test(sql)).toBe(true)
    // Must not key the delete on allowlist membership (see above).
    expect(/DELETE[\s\S]*?user_allowlist/i.test(sql)).toBe(false)
  })

  it('leaves a grace period so it cannot race an in-flight signup', () => {
    const prune = migrationFiles()
      .map((f) => stripSqlComments(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')))
      .find((sql) => /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(public\.)?prune_orphan_auth_users\b/i.test(sql))!
    expect(/created_at\s*<\s*now\(\)\s*-\s*(INTERVAL|interval)/i.test(prune)).toBe(true)
  })

  it('reports how many rows it deleted rather than returning void', () => {
    // A cleanup that returns nothing cannot be distinguished from one that found
    // nothing to do, and this one is expected to find nothing most days
    // (LESSONS L98).
    const prune = migrationFiles()
      .map((f) => stripSqlComments(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')))
      .find((sql) => /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(public\.)?prune_orphan_auth_users\b/i.test(sql))!
    expect(/RETURNS\s+(INTEGER|INT|BIGINT)/i.test(prune)).toBe(true)
  })
})
