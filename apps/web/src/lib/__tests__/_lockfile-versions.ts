/**
 * Reading resolved versions out of pnpm-lock.yaml, shared by the dependency
 * guards (pnpm-override-major-drift, next-security-floor). Moved here from the
 * drift guard so a second guard can use it without importing a test file, which
 * would register that file's suites again. Not a test (no `.test.ts` suffix), so
 * vitest does not collect it.
 */

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
