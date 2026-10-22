import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * The web app must stay on a `next` release outside two advisories published on
 * 2026-10-22 (#2675):
 *
 *   GHSA-2464-fhr4-w9xw  critical, remote code execution in Image Optimization
 *                        with SVG
 *   GHSA-p3m5-59mp-jv5r  high, denial of service against App Router Server
 *                        Actions
 *
 * On the 15 line both are fixed in 15.5.28. A downgrade, or a lockfile that
 * still resolves an older copy beside the pinned one, would ship the vulnerable
 * code while package.json looks right, so both are checked.
 *
 * Only the 15 line has a known floor here. A move to another major fails this
 * guard on purpose: look up that line's fixed release for both advisories and add
 * it to FLOORS in the same change.
 */
const FLOORS: Record<number, [number, number, number]> = {
  15: [15, 5, 28],
}

const WEB_PKG = path.join(REPO_ROOT, 'apps/web/package.json')
const LOCKFILE = path.join(REPO_ROOT, 'pnpm-lock.yaml')

type Version = [number, number, number]

/** An exact `x.y.z` version, or null for a range, a tag or anything else. */
export function parseExact(raw: string): Version | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function atLeast(v: Version, floor: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== floor[i]) return v[i] > floor[i]
  }
  return true
}

/** Why a version is unsafe, or null when it is outside both advisories. */
export function advisoryProblem(raw: string): string | null {
  const v = parseExact(raw)
  if (!v) return `"${raw}" is not an exact x.y.z pin, so the shipped release cannot be checked`
  const floor = FLOORS[v[0]]
  if (!floor) {
    return `next ${raw} is on major ${v[0]}, which has no recorded fixed release; add its floor for GHSA-2464-fhr4-w9xw and GHSA-p3m5-59mp-jv5r to FLOORS`
  }
  if (!atLeast(v, floor)) {
    return `next ${raw} is below ${floor.join('.')}, inside GHSA-2464-fhr4-w9xw and GHSA-p3m5-59mp-jv5r`
  }
  return null
}

describe('next stays outside the 2026-10-22 advisories (#2675)', () => {
  it('judges versions on the 15 line by the 15.5.28 floor', () => {
    expect(advisoryProblem('15.5.28')).toBeNull()
    expect(advisoryProblem('15.5.29')).toBeNull()
    expect(advisoryProblem('15.6.0')).toBeNull()
    expect(advisoryProblem('15.5.24')).toMatch(/below 15\.5\.28/)
    expect(advisoryProblem('15.4.99')).toMatch(/below 15\.5\.28/)
    expect(advisoryProblem('14.2.30')).toMatch(/no recorded fixed release/)
    expect(advisoryProblem('^15.5.28')).toMatch(/not an exact/)
  })

  it('apps/web/package.json pins next and eslint-config-next at a safe release', () => {
    const pkg = JSON.parse(readFileSync(WEB_PKG, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const next = pkg.dependencies?.next
    expect(next, 'apps/web/package.json declares no next dependency').toBeDefined()
    expect(advisoryProblem(next as string)).toBeNull()
    // Kept on the same release as next, so its lint rules match the framework.
    expect(pkg.devDependencies?.['eslint-config-next']).toBe(next)
  })

  it('the lockfile resolves no vulnerable copy of next', () => {
    const lock = readFileSync(LOCKFILE, 'utf8')
    const resolved = new Set<string>()
    // The bare package only: a scoped name ending in /next (`@vercel/next@4.12.4`)
    // or a hyphenated one (`eslint-config-next@`) is a different package.
    for (const m of lock.matchAll(/(?:^|[\s('])next@(\d+\.\d+\.\d+)/gm)) resolved.add(m[1])
    expect(resolved.size, 'no next@x.y.z entry found in pnpm-lock.yaml').toBeGreaterThan(0)
    const problems = [...resolved].map(advisoryProblem).filter((p): p is string => p !== null)
    expect(problems).toEqual([])
  })
})
