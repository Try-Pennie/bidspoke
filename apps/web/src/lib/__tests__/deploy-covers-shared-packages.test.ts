import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, workspacePackages } from './_scan-utils'

/**
 * A change to shared code must be able to reach production (#869).
 *
 * Deployment decides what to ship from a paths filter per target, and the three
 * drift checks that catch a committed-but-never-deployed target ask git the same
 * question over the same paths. Before this, both lists named the two app
 * directories and the lockfile and nothing else, so introducing `packages/*` left
 * a hole with a very specific shape:
 *
 *   a commit touching ONLY a shared package deploys nowhere, AND all three drift
 *   checks report every target up to date, because they are asking about
 *   directories the commit did not touch.
 *
 * That is #327, #802 and #804 all over again, reintroduced by adding a directory.
 * It is the worst version of the class, because the guard built to catch a
 * stranded deploy is blind to this one by construction rather than by accident.
 *
 * It did not fire on the commit that created the package only because that commit
 * also changed `pnpm-lock.yaml`, which IS in every filter. The next edit to the
 * shared file alone would not have shipped.
 *
 * The two existing binding tests cannot catch this. They assert the deploy filter
 * and the drift check agree with EACH OTHER, and here they agreed perfectly while
 * both were wrong (L178: two conditions checked against one body of text prove
 * neither half, and agree hardest when nothing works). So this asserts against the
 * packages that actually EXIST, which is the code-to-registry direction (L96).
 *
 * The coverage is a deliberate SUPERSET: every target watches every shared
 * package, rather than only the ones it imports. Deriving it from real dependency
 * edges would be more precise and would silently miss a package added to an app
 * without the filter being revisited, and over-triggering costs nothing here
 * because the worker deploy compares built bundle bytes and skips when they match.
 */
const readRepoText = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), 'utf8')

/** The paths a named `dorny/paths-filter` entry in deploy.yml gates on. */
const deployFilterPaths = (filterName: string): string[] => {
  const lines = readRepoText('.github/workflows/deploy.yml').split('\n')
  const start = lines.findIndex((line) => new RegExp(`^\\s{12}${filterName}:\\s*$`).test(line))
  expect(start, `deploy.yml no longer has a \`${filterName}:\` paths filter`).toBeGreaterThan(-1)
  const paths: string[] = []
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^\s+-\s+'([^']+)'\s*$/)
    if (!match) break
    paths.push(match[1])
  }
  expect(paths.length, `the ${filterName} filter matched no paths, so this asserts nothing`).toBeGreaterThan(0)
  return paths
}

/** Whether `paths` contains an entry that would match a change inside `dir`. */
const covers = (paths: string[], dir: string): boolean =>
  paths.some((p) => p === dir || p === `${dir}/**` || p.replace(/\/\*\*$/, '') === dir)

/** Workspace packages that are NOT one of the deployable apps. */
const sharedPackages = () => workspacePackages().filter((p) => !p.relativeDir.startsWith('apps/'))

/** The parent directory each shared package lives under, e.g. `packages`. */
const sharedParents = (): string[] => [
  ...new Set(sharedPackages().map((p) => p.relativeDir.split('/')[0])),
]

describe('every deploy target can see a shared package change (#869)', () => {
  it('has shared packages to check, so this cannot pass vacuously', () => {
    // With no shared packages every assertion below is trivially true, and that
    // is exactly the state a renamed workspace glob produces (L98).
    expect(sharedPackages().length).toBeGreaterThan(0)
  })

  it.each(['worker', 'worker_tail', 'pages'])('is gated by a filter covering shared code: %s', (filterName) => {
    const paths = deployFilterPaths(filterName)
    for (const parent of sharedParents()) {
      expect(
        covers(paths, parent),
        `Deploy's \`${filterName}\` filter ignores ${parent}, so a commit touching only shared code never deploys it`,
      ).toBe(true)
    }
  })
})

describe('every drift check can see a shared package change (#869)', () => {
  const driftPathsFor = (variable: string): string[] => {
    const drift = readRepoText('.github/workflows/deploy-drift.yml')
    const match = drift.match(new RegExp(`${variable}=\\$\\(git log -1 --format=%H -- ([^)\\n]+)\\)`))
    expect(match, `the drift job no longer derives ${variable} from git`).not.toBeNull()
    return match![1].trim().split(/\s+/)
  }

  it.each(['LAST_WORKER_COMMIT', 'LAST_WEB_COMMIT', 'LAST_TAIL_COMMIT'])(
    'reads history over shared code too: %s',
    (variable) => {
      const asked = driftPathsFor(variable)
      for (const parent of sharedParents()) {
        expect(
          covers(asked, parent),
          `the drift check behind ${variable} never looks at ${parent}, so a shared change stranded on main reads as up to date`,
        ).toBe(true)
      }
    },
  )
})
