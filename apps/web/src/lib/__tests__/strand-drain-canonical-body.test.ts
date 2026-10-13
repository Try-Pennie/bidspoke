/**
 * The restated strand-drain body is pinned to one canonical copy (#1161).
 *
 * `reduce_finalize_stranded` has no ALTER for a single plpgsql assignment, so
 * every change to it ships as a fresh migration carrying the whole function
 * restated as a `CREATE OR REPLACE`. Adding one recovery field means pasting
 * roughly 80 lines, and #1159 was the third migration to copy the body to add a
 * line (20260625000003, 20260627000001, 20260904170001, then 20260909150000 and
 * 20261011120000).
 *
 * Two problems follow, and neither existing guard sees them:
 *   - worker-strand-drain-contract.test.ts (#367) checks only that each
 *     projected field is READ. A transcription slip anywhere in the 80 untouched
 *     lines passes it, passes CI, and corrupts a recovery path that by
 *     definition only runs after a strand has already happened, so nothing
 *     exercises it until a real strand arrives.
 *   - security-definer-grants.test.ts (#762) concatenates every migration, so a
 *     REVOKE in ANY migration satisfies it. A restatement that silently drops
 *     its own REVOKE still passes, even though the author restates it on every
 *     replace on purpose: this is a SECURITY DEFINER function that writes and
 *     takes a caller-supplied lookback.
 *
 * This guard pins the latest restated body to a single canonical copy. To change
 * the function: edit the canonical file (its git diff IS the reviewable intended
 * change), then paste it verbatim under the new migration's header comment. The
 * guard fails, naming the first divergent line, if the latest defining
 * migration's function block is not identical to the canonical (trailing
 * whitespace and trailing blank lines normalized away), so an accidental edit
 * anywhere in the body fails loudly rather than reaching production unexercised.
 * It also fails if the canonical does not revoke EXECUTE from PUBLIC, anon and
 * authenticated, so the REVOKE cannot be forgotten in a future restatement.
 *
 * The canonical captures everything from the `CREATE OR REPLACE` line to the end
 * of the migration (the function, its GRANT and its REVOKE). Every strand-drain
 * migration to date is exactly that and nothing else; a future one that restates
 * the drain keeps to the same shape.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './_scan-utils'

const MIGRATIONS = path.join(REPO_ROOT, 'supabase/migrations')
const CANONICAL = path.join(REPO_ROOT, 'apps/web/src/lib/__tests__/fixtures/reduce-finalize-stranded.canonical.sql')

// Word-boundary the function name so reduce_finalize_stranded_executions (the
// unrelated workflow_executions strand drain, 20260708000001) is not mistaken
// for a restatement of this lead_sightings drain.
const DEFINES_DRAIN = /create\s+or\s+replace\s+function\s+public\.reduce_finalize_stranded\s*\(/i

/** The highest-versioned migration that restates the drain. */
function latestDefiningMigration(): string {
  const defining = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => DEFINES_DRAIN.test(readFileSync(path.join(MIGRATIONS, f), 'utf8')))
    .sort()
  if (defining.length === 0) throw new Error('no migration defines reduce_finalize_stranded')
  return defining[defining.length - 1]
}

/**
 * The function-definition block: from the CREATE OR REPLACE line to the end of
 * the file. Normalized so trailing whitespace and trailing blank lines are not a
 * source of spurious divergence.
 */
function functionBlock(sql: string): string[] {
  const start = sql.search(DEFINES_DRAIN)
  if (start === -1) throw new Error('CREATE OR REPLACE FUNCTION line not found')
  // Back up to the start of the CREATE line (search matches at `create`, which
  // begins the line already, but be explicit so a leading indent is included).
  const lineStart = sql.lastIndexOf('\n', start) + 1
  const lines = sql.slice(lineStart).split('\n').map((l) => l.replace(/\s+$/, ''))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function firstDivergence(a: string[], b: string[]): { line: number; a: string; b: string } | null {
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) return { line: i + 1, a: a[i] ?? '<end of file>', b: b[i] ?? '<end of file>' }
  }
  return null
}

describe('firstDivergence and functionBlock behave (#1161)', () => {
  it('returns null when two blocks are identical', () => {
    expect(firstDivergence(['a', 'b'], ['a', 'b'])).toBeNull()
  })

  it('reports the first differing line, 1-indexed', () => {
    expect(firstDivergence(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual({ line: 2, a: 'b', b: 'x' })
  })

  it('reports a length mismatch as a divergence at the extra line', () => {
    expect(firstDivergence(['a', 'b'], ['a'])).toEqual({ line: 2, a: 'b', b: '<end of file>' })
  })

  it('extracts from the CREATE line to the end and normalizes trailing whitespace', () => {
    const sql = '-- header comment\n-- more header\nCREATE OR REPLACE FUNCTION public.reduce_finalize_stranded(x int)\nAS $$ $$;   \nREVOKE ALL;\n\n\n'
    expect(functionBlock(sql)).toEqual([
      'CREATE OR REPLACE FUNCTION public.reduce_finalize_stranded(x int)',
      'AS $$ $$;',
      'REVOKE ALL;',
    ])
  })
})

describe('strand drain body matches the canonical copy (#1161)', () => {
  const latestFile = latestDefiningMigration()
  const migrationBlock = functionBlock(readFileSync(path.join(MIGRATIONS, latestFile), 'utf8'))
  const canonicalBlock = functionBlock(readFileSync(CANONICAL, 'utf8'))

  it('has a non-trivial canonical body, so the guard cannot pass vacuously', () => {
    // An empty or truncated canonical would otherwise match an equally broken
    // migration, or make every assertion below trivially hold (L98).
    expect(canonicalBlock.length).toBeGreaterThan(40)
    expect(canonicalBlock[0]).toMatch(DEFINES_DRAIN)
    expect(canonicalBlock.join('\n')).toContain('$$;')
  })

  it('restates the canonical body verbatim in the latest defining migration', () => {
    const d = firstDivergence(migrationBlock, canonicalBlock)
    expect(
      d,
      d
        ? `${latestFile} diverges from the canonical at line ${d.line}:\n  migration: ${d.a}\n  canonical: ${d.b}\n` +
            `Paste the canonical verbatim below the migration header, or update the canonical if the change is intended.`
        : undefined,
    ).toBeNull()
  })

  it('revokes EXECUTE from PUBLIC, anon and authenticated in the canonical body', () => {
    // Enforced on the canonical (and so on every restatement that matches it)
    // because the #762 guard is satisfied by a REVOKE in ANY migration, so it
    // cannot see one dropped from a fresh restatement.
    const body = canonicalBlock.join('\n')
    const revoke = body.match(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.reduce_finalize_stranded\s*\([^)]*\)\s+FROM\s+([^;]+);/i)
    expect(revoke, 'canonical body has no REVOKE ALL ... FROM ... for the drain').not.toBeNull()
    const targets = (revoke?.[1] ?? '').toLowerCase()
    for (const who of ['public', 'anon', 'authenticated']) {
      expect(targets, `REVOKE does not include ${who}`).toContain(who)
    }
  })
})
