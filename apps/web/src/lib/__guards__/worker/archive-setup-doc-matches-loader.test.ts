import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, WORKER_SRC } from '../../__tests__/_scan-utils'

/**
 * The archive setup script must not describe a loader that does not exist
 * (#987).
 *
 * `docs/snowflake-archive-setup.sql` is the file somebody follows when
 * rebuilding the archive database. It told them "Idempotency comes from the
 * loader using MERGE keyed on (archive_day, execution_id)", and built its
 * argument for the table carrying no uniqueness constraint on that basis. The
 * loader says "Plain INSERT, never MERGE" in its own opening lines and emits an
 * INSERT.
 *
 * That is not tidiness. The script promised a de-duplication property that does
 * not exist, and re-sends are DESIGNED IN: an hour that fails to reconcile does
 * not advance the watermark and is read and sent again. Anyone reading the
 * script would conclude duplicates cannot happen, and the deletion gate's whole
 * read-time deduplication would look unnecessary. Docs describing a system that
 * no longer exists have cost time on this project before.
 *
 * Derived from both artifacts rather than restated here, so this cannot drift
 * into a third definition that agrees with neither (L107, L41).
 */
const DDL = path.join(REPO_ROOT, 'docs/snowflake-archive-setup.sql')
const SEND = path.join(WORKER_SRC, 'lib/execution-archive-send.ts')

/** The statement verb the loader actually emits, read out of the builder itself. */
function loaderVerb(): 'INSERT' | 'MERGE' | 'unknown' {
  const source = readFileSync(SEND, 'utf8')
  // The emitted statement, not the prose about it: a comment saying "never
  // MERGE" must not be what decides this.
  const emits = source.match(/`\s*(INSERT|MERGE)\s+INTO/i) ?? source.match(/'\s*(INSERT|MERGE)\s+INTO/i)
  if (emits) return emits[1].toUpperCase() as 'INSERT' | 'MERGE'
  return 'unknown'
}

describe('the archive setup script and the loader agree (#987)', () => {
  it('reads a real verb out of the loader, so the checks below are not vacuous', () => {
    // Without this the guard passes hardest when the regex matches nothing,
    // which is the shape that reports green while blind (L178).
    expect(loaderVerb()).not.toBe('unknown')
  })

  it('does not tell the operator that the loader deduplicates with MERGE', () => {
    const doc = readFileSync(DDL, 'utf8')
    const claims = doc
      .split('\n')
      .filter((line) => /\bMERGE\b/.test(line))
      // The one sentence allowed to say the word is the correction itself,
      // which exists to stop the belief coming back.
      .filter((line) => !/It does not|used to say/i.test(line))

    expect(claims, `these lines credit the loader with MERGE, which emits ${loaderVerb()}`).toEqual([])
  })

  it('tells the operator that duplicates are expected and handled at read time', () => {
    // Removing the false claim is not enough on its own: silence would leave the
    // reader to assume uniqueness, which is the belief that caused the problem.
    const doc = readFileSync(DDL, 'utf8')

    expect(doc).toMatch(/DUPLICATE ROWS ARE A\s*\n--\s*NORMAL STATE|DUPLICATE ROWS ARE A NORMAL STATE/)
    expect(doc).toMatch(/read time/i)
  })

  it('says why a uniqueness constraint is deliberately absent', () => {
    const doc = readFileSync(DDL, 'utf8')

    expect(doc).toMatch(/turn a harmless re-send into a send failure/i)
  })
})
