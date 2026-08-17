import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listFiles, REPO_ROOT } from './_scan-utils'

/**
 * The data classification document must name every table that holds personal
 * data (#257).
 *
 * A classification document is exactly the artifact that goes stale silently. It
 * is written once, against the schema of its own date, and from then on every
 * migration that adds a personal-data column makes it quietly less true. Nobody
 * notices, because a document cannot fail. The first time anyone finds out is
 * when they answer a question about what we hold and are wrong.
 *
 * So this closes the loop in the schema-to-document direction (LESSONS L96, and
 * L41: a list that must mirror a source of truth is derived from it, never
 * maintained by hand beside it). The migrations are the source of truth for what
 * columns exist, they are in git, and they can be read without a database.
 *
 * It lives with the general guards rather than in the worker guard directory,
 * because its subject is the MIGRATIONS and the document, not worker source. The
 * placement guard from #502 caught it in the wrong place on its first run, which
 * is the most convincing evidence that guard works that could be asked for.
 *
 * The check is deliberately at TABLE granularity rather than column. The
 * document is prose meant to be read by a person, and demanding it recite every
 * column name would make it worse to read while catching nothing extra: a new
 * personal-data column almost always lands on a table that either is already
 * classified, in which case the classification still holds, or is not, which is
 * the case that matters and the case this catches.
 */
const MIGRATIONS = path.join(REPO_ROOT, 'supabase/migrations')
const DOC = path.join(REPO_ROOT, 'docs/security/data-classification-and-retention.md')

/**
 * Column names that mean personal data. Matched against `CREATE TABLE` bodies.
 *
 * Assembled from fragments so this file does not itself contain the words it
 * searches for, which would otherwise make the document's own name-checks match
 * this test if the two are ever scanned together (L103, L135).
 */
const PII_COLUMN = new RegExp(
  [
    ['ssn'].join(''),
    ['social', 'security'].join('_'),
    ['date', 'of', 'birth'].join('_'),
    ['first', 'name'].join('_'),
    ['last', 'name'].join('_'),
    'dob',
    'email',
    'phone',
    'street',
    'zip',
    ['credit', 'score'].join('_'),
    ['annual', 'income'].join('_'),
  ].join('|'),
  'i',
)

/**
 * Tables the document deliberately does not classify as consumer data, because
 * they are staff or operational records, plus the partition children whose
 * parent is already classified.
 *
 * This is not an exemption from review: every name here is covered by the
 * document's own "Where staff data lives" section, which is the thing L129 asks
 * for, something named that DOES review the excluded category.
 */
const STAFF_OR_OPERATIONAL = new Set([
  'users',
  'user_allowlist',
  'workflows',
  'workflow_versions',
  'environment_variables',
  'partner_configs',
  'partner_bid_configs',
  'service_connections',
  'app_settings',
  'audit_log',
  'webhook_endpoints',
  'api_sources',
  'sources',
])

/** Every `CREATE TABLE` in the migrations whose body declares a personal-data column. */
function tablesHoldingPii(): Set<string> {
  const found = new Set<string>()
  const files = listFiles(MIGRATIONS, { exts: ['.sql'] })
  expect(files.length, 'no migrations found, so this guard is asserting nothing').toBeGreaterThan(0)

  for (const file of files) {
    const sql = readFileSync(file, 'utf8')
    // Strip line comments first. A migration that EXPLAINS a column in prose must
    // not read as a migration that creates one (L103).
    const code = sql.replace(/--[^\n]*/g, '')
    const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(code))) {
      const table = m[1].toLowerCase()
      // The body runs to the matching close paren of the CREATE TABLE.
      let depth = 0
      let end = m.index + m[0].length - 1
      for (let i = end; i < code.length; i++) {
        if (code[i] === '(') depth++
        else if (code[i] === ')') {
          depth--
          if (depth === 0) {
            end = i
            break
          }
        }
      }
      const body = code.slice(m.index, end)
      if (PII_COLUMN.test(body)) found.add(table)
    }
  }
  return found
}

/** Partition children are covered by their parent's classification. */
const isPartitionOf = (table: string, parents: Set<string>): boolean =>
  [...parents].some((p) => table !== p && table.startsWith(`${p}_`) && /_\d{4}(_\d{2}){1,2}$/.test(table))

describe('the data classification document names every table holding personal data (#257)', () => {
  it('finds tables with personal-data columns at all, so this cannot pass vacuously', () => {
    // Without this, a change to the migration directory or to the CREATE TABLE
    // shape would satisfy the assertion below by finding nothing to assert about
    // (L98). An empty result is the one answer this guard must never accept.
    expect(tablesHoldingPii().size).toBeGreaterThan(2)
  })

  it('classifies every one of them, or names it as staff and operational', () => {
    const doc = readFileSync(DOC, 'utf8')
    expect(doc.length, 'the classification document is empty').toBeGreaterThan(1000)

    const tables = tablesHoldingPii()
    const unclassified = [...tables]
      .filter((t) => !STAFF_OR_OPERATIONAL.has(t))
      .filter((t) => !isPartitionOf(t, tables))
      .filter((t) => !doc.includes(t))

    expect(
      unclassified.sort(),
      'these tables hold personal data and the classification document does not mention them, so anyone reading it to answer what we hold would be wrong',
    ).toEqual([])
  })
})

describe('the document keeps saying how to re-derive itself (#257)', () => {
  it('tells the reader how to re-measure the retention windows', () => {
    // The retention half cannot be enforced by a test: it lives in cron jobs in
    // the live database and in worker code, and this suite reaches neither. What
    // it can insist on is that the document never presents those numbers as
    // facts to trust on sight, since a measured number quietly becomes a
    // hand-written one the moment nobody can tell where it came from (L32).
    const doc = readFileSync(DOC, 'utf8')
    expect(doc, 'the document no longer explains how to re-measure its own numbers').toMatch(
      /How to re-measure/i,
    )
    expect(doc).toContain('cron.job')
  })

  it('states plainly that the write-time redaction is off', () => {
    // The single most misreadable fact here. A redaction mechanism that exists
    // and is disabled reads, to anyone skimming, exactly like one that is
    // protecting the payloads.
    const doc = readFileSync(DOC, 'utf8')
    expect(doc).toMatch(/PII_REDACTION_FIELDS/)
    expect(doc).toMatch(/\*\*It is off\.\*\*/)
  })
})
