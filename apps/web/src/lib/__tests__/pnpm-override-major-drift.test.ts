import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * A `pnpm.overrides` entry must not silently perform a MAJOR upgrade.
 *
 * Every override in this repo exists to force a vulnerable transitive dependency
 * up to its PATCHED version, so the security scan can pass on a real fix rather
 * than a `.trivyignore` entry. Written as a bare minimum (`">=3.3.18"`) it also
 * permits every future major, and pnpm resolves the newest thing that satisfies
 * it. The consumer never asked for that major and is not tested against it.
 *
 * Found 2026-08-14 while patching nanoid for CVE-2026-67213: `">=3.3.18"`
 * resolved to nanoid **6.0.1**, and nanoid 5+ is ESM-only while its only consumer
 * here (postcss) requires CJS, so the CSS build would have broken. Checking the
 * siblings then showed the same thing already shipped: `glob@>=10.2.0 <10.5.0`
 * overridden to `">=10.5.0"` had resolved to **glob 13.0.6**, three majors past
 * the 10.x line that docs/security/dependency-audit-baseline.md claims it pins.
 *
 * So the rule is a policy, not semver: a patch override stays inside the major of
 * the version it is patching to. Cross a major deliberately, in its own change,
 * with the consumer re-tested.
 */
const PKG_JSON = path.join(REPO_ROOT, 'package.json')
const LOCKFILE = path.join(REPO_ROOT, 'pnpm-lock.yaml')

export interface OverrideDrift {
  /** Package name, e.g. `glob`. */
  name: string
  /** The override's replacement range, e.g. `>=10.5.0`. */
  range: string
  /** Lower bound parsed out of that range, e.g. `10.5.0`. */
  floor: string
  /** The resolved version that crossed a major, e.g. `13.0.6`. */
  resolved: string
}

/** Package name from an override key: `glob@>=10.2.0 <10.5.0` -> `glob`. */
export function overrideName(key: string): string {
  const at = key.lastIndexOf('@')
  // A scoped name starts with `@`, so an `@` at index 0 is part of the name.
  return at > 0 ? key.slice(0, at) : key
}

/** Lowest version a replacement range permits: `">=3.3.18 <4"` -> `3.3.18`. */
export function rangeFloor(range: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(range)
  return m ? m[0] : null
}

/** A version segment as a number, or null when it is not one. */
export function parseSegment(raw: string | undefined): number | null {
  if (raw === undefined) return 0 // `3.3` means `3.3.0`
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : null
}

/**
 * -1 / 0 / 1, comparing dotted numeric versions, or null when either side has a
 * segment that is not a plain number (a prerelease tag, a git ref, `latest`).
 *
 * Null rather than a number on purpose: `parseInt` would hand back NaN here, and
 * NaN loses every comparison silently, so an unreadable version would slide past
 * the floor check and be reported as clean. The caller maps null to the loud
 * side and examines the entry instead.
 */
export function compareVersions(a: string, b: string): number | null {
  for (let i = 0; i < 3; i++) {
    const x = parseSegment(a.split('.')[i])
    const y = parseSegment(b.split('.')[i])
    if (x === null || y === null) return null
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Every version of `name` present under the lockfile's `packages:` section. */
export function resolvedVersions(lockfile: string, name: string): string[] {
  const out: string[] = []
  let inPackages = false
  for (const line of lockfile.split('\n')) {
    const section = /^([a-z][a-zA-Z]*):$/.exec(line)
    if (section) {
      inPackages = section[1] === 'packages'
      continue
    }
    if (!inPackages) continue
    const entry = /^ {2}(\S.*)@(\d+\.\d+\.\d+[^:]*):$/.exec(line)
    if (entry && entry[1] === name) out.push(entry[2])
  }
  return out
}

/**
 * Overrides whose resolved version sits at or above the patch floor but in a
 * different major. Versions BELOW the floor are left alone by a range-scoped
 * override (glob 7 is not a product of the glob 10.x override), so they are not
 * drift.
 */
export function findOverrideDrift(
  overrides: Record<string, string>,
  lockfile: string,
): OverrideDrift[] {
  const drift: OverrideDrift[] = []
  for (const [key, range] of Object.entries(overrides)) {
    const name = overrideName(key)
    const floor = rangeFloor(range)
    if (!floor) continue
    const floorMajor = floor.split('.')[0]
    for (const resolved of resolvedVersions(lockfile, name)) {
      // An unreadable version (null) is NOT skipped: it is reported, so a shape
      // this guard cannot compare surfaces rather than passing as clean.
      const cmp = compareVersions(resolved, floor)
      if (cmp !== null && cmp < 0) continue
      if (cmp !== null && resolved.split('.')[0] === floorMajor) continue
      drift.push({ name, range, floor, resolved })
    }
  }
  return drift
}

const readOverrides = (): Record<string, string> =>
  JSON.parse(readFileSync(PKG_JSON, 'utf8')).pnpm?.overrides ?? {}

describe('pnpm.overrides major drift', () => {
  it('no override has resolved past the major it patches to', () => {
    const drift = findOverrideDrift(readOverrides(), readFileSync(LOCKFILE, 'utf8'))
    const described = drift.map(
      (d) => `${d.name}: override "${d.range}" resolved to ${d.resolved}, past major ${d.floor.split('.')[0]}`,
    )
    expect(described, 'scope the override, e.g. ">=10.5.0 <11"').toEqual([])
  })

  it('actually read overrides and found each one in the lockfile', () => {
    // Without this the guard passes on a renamed field or a moved lockfile,
    // having compared nothing at all.
    const overrides = readOverrides()
    const lockfile = readFileSync(LOCKFILE, 'utf8')
    expect(Object.keys(overrides).length).toBeGreaterThan(0)
    for (const key of Object.keys(overrides)) {
      expect(resolvedVersions(lockfile, overrideName(key)), `${key} missing from lockfile`).not.toEqual([])
    }
  })

  it('flags a bare minimum that jumped a major', () => {
    const lockfile = ['packages:', '', '  nanoid@6.0.1:', '    resolution: {integrity: sha512-x}', ''].join('\n')
    const drift = findOverrideDrift({ 'nanoid@<3.3.18': '>=3.3.18' }, lockfile)
    expect(drift).toEqual([{ name: 'nanoid', range: '>=3.3.18', floor: '3.3.18', resolved: '6.0.1' }])
  })

  it('accepts a resolution inside the patched major', () => {
    const lockfile = ['packages:', '', '  nanoid@3.3.18:', '    resolution: {integrity: sha512-x}', ''].join('\n')
    expect(findOverrideDrift({ 'nanoid@<3.3.18': '>=3.3.18 <4' }, lockfile)).toEqual([])
  })

  it('ignores a version below the floor, which the override never replaced', () => {
    // glob 7 coexists with the 10.x override and is not evidence of drift.
    const lockfile = ['packages:', '', '  glob@7.2.3:', '    resolution: {integrity: sha512-x}', ''].join('\n')
    expect(findOverrideDrift({ 'glob@>=10.2.0 <10.5.0': '>=10.5.0' }, lockfile)).toEqual([])
  })

  it('reports, rather than skips, a version it cannot compare', () => {
    // parseInt would make this NaN, and NaN < floor is false AND NaN > floor is
    // false, so an unreadable version would silently land on the clean side.
    expect(compareVersions('3.3.next', '3.3.18')).toBeNull()
    const lockfile = ['packages:', '', '  nanoid@3.3.0-beta.1:', '    resolution: {integrity: sha512-x}', ''].join('\n')
    const drift = findOverrideDrift({ 'nanoid@<3.3.18': '>=3.3.18 <4' }, lockfile)
    expect(drift.map((d) => d.resolved)).toEqual(['3.3.0-beta.1'])
  })

  it('reads a scoped package name without splitting it at its own @', () => {
    expect(overrideName('@scope/pkg@<1.2.3')).toBe('@scope/pkg')
    expect(overrideName('@scope/pkg')).toBe('@scope/pkg')
    expect(overrideName('ws')).toBe('ws')
  })

  it('only reads the packages section, not snapshots', () => {
    const lockfile = ['snapshots:', '', '  nanoid@6.0.1:', '    dependencies: {}', ''].join('\n')
    expect(resolvedVersions(lockfile, 'nanoid')).toEqual([])
  })
})
