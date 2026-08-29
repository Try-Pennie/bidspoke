import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * The Vercel CLI that builds the Pages artifact must be installed and pinned
 * (#1064).
 *
 * `pages:build` is `npx @cloudflare/next-on-pages`, and next-on-pages runs
 * `vercel build` underneath. `vercel` is a peer dependency it declares, and
 * nothing in this repo installed it, so npx fetched it on every build: about 9
 * seconds of uncached download on the critical path of the a11y job, the auth
 * gate job, Deploy Pages, and every local `pages:build`.
 *
 * The download was the smaller half. npx resolves whatever is latest THAT DAY,
 * so the version was nobody's decision. Measured in the CI run at 2026-08-29
 * 14:22 UTC it announced `Vercel CLI 59.10.0`, twelve majors past the top of the
 * range next-on-pages declares it supports. The production artifact had been
 * built by an unvetted major for some time, and the day it broke, the change
 * would have been invisible: no commit, no lockfile line, nothing to bisect
 * (L25).
 *
 * So this asserts both halves: the CLI is declared, and it is a version the
 * adapter actually claims to support. The supported range is READ from the
 * installed adapter rather than copied here, so an adapter upgrade that widens
 * or narrows it moves this guard with it (L41).
 *
 * THE PIN ONLY WORKS ON A PNPM WHOSE `pnpm list` OUTPUT THE ADAPTER CAN PARSE,
 * which is why the pnpm version is asserted below. Measured 2026-08-29 while
 * building this: next-on-pages decides between `pnpm exec vercel` and
 * `pnpm dlx vercel` by running `pnpm list --depth=0` and matching the line
 * `^vercel\s+(.*)$`.
 *
 *   pnpm 9  prints `vercel 47.0.4`        -> matched, runs `pnpm exec vercel build`
 *   pnpm 10 prints `├── vercel@47.0.4`    -> no match, runs `pnpm dlx vercel build`
 *
 * CI and Deploy both pin pnpm 9, so the pin takes effect there, and that is
 * verified in the build log rather than assumed: the run under pnpm 9 reports
 * "Vercel CLI 47.0.4" and "Completed `pnpm exec vercel build`". A local build on
 * pnpm 10 still downloads, which is a next-on-pages limitation and costs only
 * the developer's own time.
 *
 * The consequence worth keeping: bumping pnpm past 9 silently reverts this fix.
 * Nothing fails, the artifact still builds, and the download simply comes back
 * along with an unchosen CLI version. Hence the last test here, which turns that
 * invisible regression into a red one (L3).
 */
const WEB_PKG = path.join(REPO_ROOT, 'apps/web/package.json')
const ADAPTER_PKG = path.join(
  REPO_ROOT,
  'apps/web/node_modules/@cloudflare/next-on-pages/package.json',
)

interface Manifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  scripts?: Record<string, string>
}

const read = (file: string): Manifest => {
  expect(existsSync(file), `${file} does not exist`).toBe(true)
  return JSON.parse(readFileSync(file, 'utf8')) as Manifest
}

/** The declared `vercel` version in apps/web, from either dependency block. */
function declaredVercel(): string | undefined {
  const pkg = read(WEB_PKG)
  return pkg.devDependencies?.vercel ?? pkg.dependencies?.vercel
}

const toParts = (version: string): number[] => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  expect(match, `'${version}' is not a plain x.y.z version`).not.toBeNull()
  return [Number(match![1]), Number(match![2]), Number(match![3])]
}

/** -1, 0 or 1, comparing two x.y.z versions. */
function compare(a: string, b: string): number {
  const [x, y] = [toParts(a), toParts(b)]
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  }
  return 0
}

describe('the Vercel CLI used by pages:build is pinned (#1064)', () => {
  it('is declared as a dependency rather than fetched by npx at build time', () => {
    expect(
      declaredVercel(),
      'apps/web declares no `vercel`, so next-on-pages falls back to npx and downloads an arbitrary version on every build',
    ).toBeDefined()
  })

  it('is pinned exactly, not to a range', () => {
    // A caret here would put the version back in npx's hands one resolution
    // later: the whole failure being fixed is a build whose inputs nobody chose.
    const declared = declaredVercel()!
    expect(
      /^\d+\.\d+\.\d+$/.test(declared),
      `apps/web declares vercel as '${declared}'. Pin an exact version, so the artifact is built by a version somebody chose.`,
    ).toBe(true)
  })

  it('is a version next-on-pages says it supports', () => {
    // Read from the adapter, never copied. An adapter upgrade that moves the
    // supported range moves this assertion with it, rather than leaving a number
    // here that is right on the day it is written and silently wrong after.
    const range = read(ADAPTER_PKG).peerDependencies?.vercel
    expect(range, '@cloudflare/next-on-pages no longer declares a vercel peer range').toBeDefined()

    const bounds = /^>=\s*([\d.]+)\s*&&\s*<=\s*([\d.]+)$/.exec(range!.trim())
    // Refuse an unparseable range rather than treat it as satisfied. A guard
    // that answers "fine" when it could not read its own input is
    // indistinguishable from one that checked (L215).
    expect(
      bounds,
      `the vercel peer range is now '${range!}', which this guard cannot read. Teach it the new shape rather than deleting the check.`,
    ).not.toBeNull()

    const [, low, high] = bounds!
    const declared = declaredVercel()!
    expect(
      compare(declared, low) >= 0 && compare(declared, high) <= 0,
      `apps/web pins vercel ${declared}, outside the ${range!} that @cloudflare/next-on-pages declares it supports. The Pages artifact would be built by a version the adapter is not verified against.`,
    ).toBe(true)
  })

  it('runs on a pnpm whose `pnpm list` output next-on-pages can read', () => {
    // Not a rule against upgrading pnpm. It is the thing that makes the pin
    // above real, and its failure is completely silent: on pnpm 10 the adapter
    // simply stops finding the local CLI and goes back to downloading whatever
    // is newest, with a green build either way.
    //
    // If you are here because you bumped pnpm: run `pnpm run pages:build` and
    // read the log. Keep the bump only if it says "Completed `pnpm exec vercel
    // build`". If it says `pnpm dlx`, the download and the unpinned version are
    // both back.
    for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/deploy.yml']) {
      const yaml = readFileSync(path.join(REPO_ROOT, workflow), 'utf8')
      const versions = [...yaml.matchAll(/pnpm\/action-setup@[^\n]*\n\s*with:\n\s*version:\s*(\S+)/g)].map(
        (m) => m[1],
      )
      expect(versions.length, `${workflow} sets up pnpm nowhere, so this cannot pass vacuously`).toBeGreaterThan(0)
      for (const version of versions) {
        expect(
          version,
          `${workflow} sets up pnpm ${version}. next-on-pages can only find the pinned vercel CLI on pnpm 9; on anything newer it silently downloads an arbitrary one instead. See this file's header.`,
        ).toBe('9')
      }
    }
  })

  it('still builds through next-on-pages, which is what picks the local CLI up', () => {
    // next-on-pages prefers a locally installed vercel. If pages:build ever
    // stopped going through it, the pin above would still read as protection
    // while nothing consulted it.
    const build = read(WEB_PKG).scripts?.['pages:build']
    expect(build, 'apps/web has no pages:build script').toBeDefined()
    expect(build!).toContain('@cloudflare/next-on-pages')
  })
})
