/**
 * Every archive read goes through one query helper, so none can skip the
 * failure counting (#1272).
 *
 * The four read functions in `archive-read.ts` each used to build their own
 * deadline race, their own catch and their own "unavailable" answer. Counting
 * the failures would then have been a rule each call site had to remember, and a
 * rule like that is not enforced by anything: the fifth read function written
 * next year is exempt from it while looking perfectly correct (L621). They now
 * share `runArchiveQuery`, which is the single place that learns whether the
 * archive answered, and this is what stops one drifting back out.
 *
 * It reads worker source, so it lives here rather than in `lib/__tests__/`,
 * which `worker-guards-placement.test.ts` enforces.
 *
 * Mutation checked: restoring a direct `execute(archiveConfig(...))` call in any
 * read function fails this.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../../__tests__/_scan-utils'

/**
 * Comments are not code, so a sentence naming the call is not a call. Without
 * this the file's own opening comment, which explains that the archive is read
 * as the reader role and quotes the expression to say so, counted as a second
 * connection and the guard reported a violation that did not exist (#1118).
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const ARCHIVE_READ = path.join(REPO_ROOT, 'apps/worker/src/lib/archive-read.ts')

describe('archived reads all report their outcome (#1272)', () => {
  it('builds the reader connection in exactly one place', () => {
    const src = stripComments(readFileSync(ARCHIVE_READ, 'utf8'))
    // Keyed on `archiveConfig`, not on the spelling of the call that uses it.
    // The first version of this guard matched `execute(archiveConfig(` and was
    // satisfied by a reintroduced direct call written as
    // `(deps.execute ?? executeStatement)(archiveConfig(...))`, caught by
    // mutation checking it rather than by reading it. Any route to the archive
    // has to build a connection for it, so counting the connections catches a
    // call however it is spelled (L135).
    const configs = src.match(/archiveConfig\(/g) ?? []
    expect(
      configs.length,
      'archive-read.ts must reach the archive through runArchiveQuery only, so every read is counted (#1272)',
    ).toBe(1)
  })

  it('that one place is the shared helper, not some other function', () => {
    const src = stripComments(readFileSync(ARCHIVE_READ, 'utf8'))
    const helperAt = src.indexOf('async function runArchiveQuery')
    const configAt = src.indexOf('archiveConfig(')
    expect(helperAt, 'runArchiveQuery must exist').toBeGreaterThan(-1)
    // The count alone is satisfied by one call in the WRONG function, so the
    // position is asserted too: after the helper opens and before the first read
    // function that calls it.
    expect(configAt).toBeGreaterThan(helperAt)
    expect(src.indexOf('export async function readArchivedExecution')).toBeGreaterThan(configAt)
  })
})
