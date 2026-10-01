/**
 * The package's lint must reach every directory its typecheck does (#1705).
 *
 * The tsconfig includes `scripts/porting`, the instrumenter's command line
 * tools, so CI's Typecheck job checks them, but the lint script once named only
 * `src`, so those tools were never linted anywhere. ESLint ignores files outside
 * the directory it is run from, so a glob reaching up out of the package lints
 * nothing; the script lints them from the repo root with this package's config.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const PACKAGE_DIR = path.resolve(import.meta.dirname, '..')
const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..')

const tsconfig = JSON.parse(readFileSync(path.join(PACKAGE_DIR, 'tsconfig.json'), 'utf8')) as { include: string[] }
const lint = (JSON.parse(readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8')) as { scripts: { lint: string } }).scripts.lint

/** Each eslint invocation in the script: the directory it runs from (repo relative) and its quoted globs. */
function invocations(script: string): Array<{ cwd: string; globs: string[] }> {
  const out: Array<{ cwd: string; globs: string[] }> = []
  let cwd = PACKAGE_DIR
  for (const part of script.split('&&').map((p) => p.trim())) {
    const cd = /^cd\s+(\S+)$/.exec(part)
    if (cd) {
      cwd = path.resolve(cwd, cd[1])
      continue
    }
    if (!/^eslint\b/.test(part)) continue
    const globs = [...part.matchAll(/"([^"]+)"/g)].map((m) => path.relative(REPO_ROOT, path.resolve(cwd, m[1])))
    out.push({ cwd: path.relative(REPO_ROOT, cwd), globs })
  }
  return out
}

describe('porting-evidence lint coverage', () => {
  it.each(tsconfig.include)('lints the typechecked directory %s, from a directory that contains it', (included) => {
    const dir = path.relative(REPO_ROOT, path.resolve(PACKAGE_DIR, included))
    const covering = invocations(lint).filter(({ cwd, globs }) =>
      globs.some((g) => g.startsWith(`${dir}/`)) && (cwd === '' || dir === cwd || dir.startsWith(`${cwd}/`)),
    )
    expect(covering, `lint script: ${lint}`).not.toEqual([])
  })
})
