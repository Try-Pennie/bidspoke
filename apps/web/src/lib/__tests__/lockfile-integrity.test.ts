import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * `pnpm-lock.yaml` must not contain a duplicated entry.
 *
 * Found 2026-08-14 by the #727 artifact-identity gate, which is the first thing
 * in this repo to run `pnpm install --frozen-lockfile`. It failed immediately:
 *
 *   ERR_PNPM_BROKEN_LOCKFILE ... is broken: duplicated mapping key (3234:3)
 *
 * `postcss@8.5.23` appeared twice under `packages:` and twice under `snapshots:`.
 * It had been that way since 2026-07-27 (a Dependabot minor-and-patch bump) and
 * nothing noticed for eighteen days, because every other CI job runs a bare
 * `pnpm install`, which tolerates the file and re-resolves. Only a strict parse
 * fails. CLAUDE.md meanwhile stated that CI used frozen-lockfile, which was not
 * true (both are fixed in the same change as this test).
 *
 * The guard is cheap and local, so a broken lockfile is caught by the test suite
 * rather than by whichever job happens to be strict.
 *
 * IMPORTANT, and the thing that made the first version of this wrong: a package
 * key legitimately appears in BOTH the `packages:` and `snapshots:` sections.
 * Counting keys across the whole file reports ~500 "duplicates" on a perfectly
 * healthy lockfile. Only a repeat WITHIN one section is corruption, which is also
 * exactly what the YAML parser objects to.
 */
const LOCKFILE = path.join(REPO_ROOT, 'pnpm-lock.yaml')

/** Top-level section a line belongs to, e.g. packages / snapshots / importers. */
const SECTION = /^([a-z][a-zA-Z]*):$/
/** A two-space-indented mapping key, which is one entry inside a section. */
const ENTRY = /^ {2}(\S.*):$/

export interface DuplicateEntry {
  section: string
  key: string
  line: number
}

export function findDuplicateEntries(lockfile: string): DuplicateEntry[] {
  const dupes: DuplicateEntry[] = []
  let section = ''
  let seen = new Set<string>()

  lockfile.split('\n').forEach((line, i) => {
    const sec = SECTION.exec(line)
    if (sec) {
      section = sec[1]
      seen = new Set()
      return
    }
    const entry = ENTRY.exec(line)
    if (!entry) return
    const key = entry[1]
    if (seen.has(key)) dupes.push({ section, key, line: i + 1 })
    else seen.add(key)
  })

  return dupes
}

describe('pnpm-lock.yaml integrity', () => {
  it('has no entry duplicated within a section', () => {
    // A duplicate makes `pnpm install --frozen-lockfile` fail outright with
    // ERR_PNPM_BROKEN_LOCKFILE, so anything strict about the lockfile breaks.
    const dupes = findDuplicateEntries(readFileSync(LOCKFILE, 'utf8'))
    const described = dupes.map((d) => `${d.section}:${d.key} (line ${d.line})`)
    expect(described, 'duplicated lockfile entries; regenerate with pnpm 9').toEqual([])
  })

  it('reads a lockfile with the sections it expects, so it cannot pass vacuously', () => {
    // If the file moved or the format changed, this guard would silently scan
    // nothing and report clean.
    const src = readFileSync(LOCKFILE, 'utf8')
    expect(src).toMatch(/^packages:$/m)
    expect(src).toMatch(/^snapshots:$/m)
    expect(src).toMatch(/^importers:$/m)
    expect(src.split('\n').length).toBeGreaterThan(1000)
  })

  it('detects a duplicate within a section', () => {
    const broken = [
      'packages:', '', '  postcss@8.5.23:', '    resolution: {integrity: sha512-x}',
      '', '  postcss@8.5.23:', '    resolution: {integrity: sha512-x}', '',
    ].join('\n')
    const dupes = findDuplicateEntries(broken)
    expect(dupes).toHaveLength(1)
    expect(dupes[0]).toMatchObject({ section: 'packages', key: 'postcss@8.5.23' })
  })

  it('does NOT flag the same key appearing in packages and snapshots', () => {
    // The false-positive direction, and the one that matters: this is normal
    // lockfile structure. A guard that flagged it would be red on every healthy
    // lockfile and would be deleted rather than believed.
    const healthy = [
      'packages:', '', '  postcss@8.5.23:', '    resolution: {integrity: sha512-x}', '',
      'snapshots:', '', '  postcss@8.5.23:', '    dependencies:', '      nanoid: 3.3.16', '',
    ].join('\n')
    expect(findDuplicateEntries(healthy)).toEqual([])
  })

  it('does not mistake a nested key for a section entry', () => {
    const nested = [
      'packages:', '', '  postcss@8.5.23:', '    dependencies:', '      nanoid: 3.3.16',
      '  other@1.0.0:', '    dependencies:', '      nanoid: 3.3.16', '',
    ].join('\n')
    // `dependencies:` is four-space indented under two different entries and must
    // not read as a repeated top-level entry.
    expect(findDuplicateEntries(nested)).toEqual([])
  })
})
