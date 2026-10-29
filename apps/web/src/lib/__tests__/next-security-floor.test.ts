import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'
import { compareVersions, resolvedVersions } from './_lockfile-versions'

/**
 * Security floors for known advisories (next and dompurify, published on
 * 2026-10-22, and tar, #2994), checked against the
 * versions the lockfile actually RESOLVES, because a downgrade or a stale copy
 * resolved beside the declared one ships the vulnerable code while package.json
 * looks right.
 *
 * next (#2675), fixed on the 15 line in 15.5.28:
 *   GHSA-2464-fhr4-w9xw  critical, remote code execution in Image Optimization
 *                        with SVG
 *   GHSA-p3m5-59mp-jv5r  high, denial of service against App Router Server
 *                        Actions
 *
 * dompurify (#2691), pulled in by monaco-editor, fixed in 3.4.17 and forced up
 * by the root `pnpm.overrides` entry:
 *   GHSA-mrv2-3pqr-j5jr  high
 *
 * tar (#2994), pulled in by vercel 47.0.4 through @vercel/fun 1.1.6, which
 * builds the site through next-on-pages, fixed in 7.5.19 and forced up by the
 * root `pnpm.overrides` entry. The 6 line has no fixed release, so tar 6 fails
 * here as a major with no floor:
 *   GHSA-23hp-3jrh-7fpw  critical, a crafted archive hangs the unpacker or
 *                        exhausts its memory
 *
 * A floor is per major line. A version on a major with no recorded floor fails
 * on purpose: look up that line's fixed release and add it here in the same
 * change.
 */
type Floor = { advisories: string; byMajor: Record<string, string> }

const FLOORS: Record<string, Floor> = {
  next: {
    advisories: 'GHSA-2464-fhr4-w9xw and GHSA-p3m5-59mp-jv5r',
    byMajor: { '15': '15.5.28' },
  },
  dompurify: {
    advisories: 'GHSA-mrv2-3pqr-j5jr',
    byMajor: { '3': '3.4.17' },
  },
  tar: {
    advisories: 'GHSA-23hp-3jrh-7fpw',
    byMajor: { '7': '7.5.19' },
  },
}

const WEB_PKG = path.join(REPO_ROOT, 'apps/web/package.json')
const LOCKFILE = path.join(REPO_ROOT, 'pnpm-lock.yaml')

/** Why `version` of `name` is unsafe, or null when it is at or above its floor. */
export function floorProblem(name: string, version: string): string | null {
  const floor = FLOORS[name]
  const base = version.split('(')[0]
  if (!/^\d+\.\d+\.\d+$/.test(base)) {
    return `${name} "${version}" is not an exact x.y.z version, so it cannot be checked against ${floor.advisories}`
  }
  const min = floor.byMajor[base.split('.')[0]]
  if (!min) {
    return `${name} ${base} is on a major with no recorded fixed release; add its floor for ${floor.advisories}`
  }
  const cmp = compareVersions(base, min)
  // An unreadable comparison (null) fails rather than passing as clean.
  if (cmp === null || cmp < 0) return `${name} ${base} is below ${min}, inside ${floor.advisories}`
  return null
}

const lockfile = (): string => readFileSync(LOCKFILE, 'utf8')

describe('dependencies stay outside known advisories (#2675, #2691, #2994)', () => {
  it('judges versions against each floor', () => {
    expect(floorProblem('next', '15.5.28')).toBeNull()
    expect(floorProblem('next', '15.6.0')).toBeNull()
    expect(floorProblem('next', '15.5.24')).toMatch(/below 15\.5\.28/)
    expect(floorProblem('next', '14.2.30')).toMatch(/no recorded fixed release/)
    expect(floorProblem('next', '^15.5.28')).toMatch(/not an exact/)
    expect(floorProblem('dompurify', '3.4.17')).toBeNull()
    expect(floorProblem('dompurify', '3.2.7')).toMatch(/below 3\.4\.17/)
    expect(floorProblem('tar', '7.5.19')).toBeNull()
    expect(floorProblem('tar', '7.5.18')).toMatch(/below 7\.5\.19/)
    expect(floorProblem('tar', '6.2.1')).toMatch(/no recorded fixed release/)
  })

  for (const name of Object.keys(FLOORS)) {
    it(`the lockfile resolves ${name}, and no copy below its floor`, () => {
      const versions = resolvedVersions(lockfile(), name)
      // Without this the guard passes having compared nothing, on a renamed
      // package or a moved lockfile.
      expect(versions, `${name} not found in pnpm-lock.yaml`).not.toEqual([])
      const problems = versions.map((v) => floorProblem(name, v)).filter((p): p is string => p !== null)
      expect(problems).toEqual([])
    })
  }

  it('apps/web/package.json pins next exactly at a safe release, with eslint-config-next beside it', () => {
    const pkg = JSON.parse(readFileSync(WEB_PKG, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const next = pkg.dependencies?.next
    expect(next, 'apps/web/package.json declares no next dependency').toBeDefined()
    expect(floorProblem('next', next as string)).toBeNull()
    expect(pkg.devDependencies?.['eslint-config-next']).toBe(next)
  })
})
