/**
 * Every workspace package must be linted (#907).
 *
 * Lint runs per package (`pnpm -r lint`), so a package with no `lint` script is
 * silently skipped. `packages/uuidv7`, the first shared package in the repo, had
 * none: it was never linted, and every future shared package would have
 * inherited that exemption by default rather than by decision.
 *
 * The exemption was invisible, which is the part that matters. `pnpm -r lint`
 * prints "Scope: 4 of 5 workspace projects" and reports Done, which reads
 * exactly like everything was linted (L98). Nothing was wrong, nothing was red,
 * and the rules the apps enforce simply did not apply to code both of them run.
 *
 * Unlike tests, there is no legitimate reason for a package to have no lint
 * script, so this has no exemption list. A category excluded from a check needs
 * something else named to cover it, and there is nothing else here (L129).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, workspacePackages } from './_scan-utils'

const packages = () => workspacePackages()

describe('lint coverage across the workspace', () => {
  it('finds the workspace packages, so it is asserting something', () => {
    // A guard driven by an enumeration that returns nothing passes while blind,
    // which is the same failure it exists to prevent (L96).
    expect(packages().length).toBeGreaterThan(0)
  })

  it('gives every package a lint script', () => {
    const missing = packages()
      .filter((p) => !p.scripts?.lint)
      .map((p) => p.name ?? path.relative(REPO_ROOT, p.dir))

    expect(
      missing,
      `these packages declare no lint script, so \`pnpm -r lint\` skips them entirely and reports Done:\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })

  // A lint script that runs nothing would satisfy the check above while linting
  // as little as no script at all. Two shapes are legitimate here and both are
  // NAMED: an eslint invocation scoped to src, and `next lint`, which apps/web
  // uses and which finds its own scope from the Next config. Anything else is a
  // script nobody has decided about.
  it('points each lint script at something that actually lints', () => {
    for (const p of packages()) {
      const script = p.scripts?.lint ?? ''
      const who = p.name ?? path.relative(REPO_ROOT, p.dir)

      if (/\bnext lint\b/.test(script)) continue

      expect(script, `${who} has a lint script that is neither eslint nor next lint`).toMatch(/eslint/)
      expect(script, `${who} runs eslint but scopes it to nothing under src`).toMatch(/src/)
    }
  })
})

describe('the shared rule definition', () => {
  const SHARED = path.join(REPO_ROOT, 'eslint.rules.shared.mjs')

  it('exists and holds the rules that are about correctness', () => {
    const src = readFileSync(SHARED, 'utf8')
    // Spot-checked on the rules whose absence in shared code is a real bug
    // rather than a style nit: the caught-error stringify ban and the async
    // correctness family.
    expect(src).toMatch(/no-restricted-syntax/)
    expect(src).toMatch(/no-base-to-string/)
    expect(src).toMatch(/no-floating-promises/)
  })

  // The point of extracting it. If a package restates the rules instead of
  // spreading the shared definition, it drifts the first time a rule is added,
  // and a list that must mirror another source of truth has to be derived from
  // it rather than maintained beside it (L41).
  it('is what every package config actually uses, not a copy', () => {
    for (const p of packages()) {
      const config = path.join(p.dir, 'eslint.config.mjs')
      let src: string
      try {
        src = readFileSync(config, 'utf8')
      } catch {
        // apps/web lints through `next lint`, which carries its own config, so
        // it has no flat config to point at the shared rules. It is NAMED here
        // rather than silently skipped, so the gap stays visible: the shared
        // correctness rules genuinely do not reach it, and closing that is its
        // own piece of work.
        expect(
          p.scripts?.lint,
          `${p.name ?? path.relative(REPO_ROOT, p.dir)} has no eslint.config.mjs and does not lint via next either`,
        ).toMatch(/\bnext lint\b/)
        continue
      }
      // The SPREAD, not a mention. Matching `sharedRules` anywhere in the file
      // is satisfied by the import line alone, so a config that imports the
      // shared rules and then ignores them would pass while sharing nothing
      // (L135). Caught exactly that way on the first mutation check.
      expect(src, `${p.name ?? path.relative(REPO_ROOT, p.dir)} imports the shared rules but does not spread them`).toMatch(
        /\.\.\.sharedRules/,
      )
    }
  })
})
