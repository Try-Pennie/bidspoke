/**
 * No directory of TypeScript may sit outside every typecheck (#866 fallout).
 *
 * `apps/worker/tsconfig.json` includes only `src`, so `apps/worker/scripts` was
 * typechecked by nothing. That is not cosmetic. `dry-run-archive.ts` built its
 * own `Map<string, string>` and handed it to `dispositionFor`, which wants a
 * `Map<string, WorkflowOrganization>`, so `.slug` on a bare string was
 * `undefined` and the tool reported that EVERY execution in the hour belonged to
 * "organization undefined".
 *
 * That is worse than a tool reporting nothing: it sent the reader after a
 * tenancy failure in production that was really a type error in the diagnostic.
 * A compiler would have caught it in a second, and no compiler was looking.
 *
 * The rule is per DIRECTORY rather than per file, because that is the shape of
 * the gap: nobody forgets a file, they add a directory the config was written
 * before.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, workspacePackages } from './_scan-utils'

/** Directories that are code, as opposed to build output or dependencies. */
const IGNORED = new Set(['node_modules', 'dist', '.next', '.wrangler', 'coverage', 'public', '.turbo'])

/**
 * Strip the comments a tsconfig may carry, LINE BY LINE.
 *
 * Deliberately not a regex over the whole file. A block-comment pattern run
 * across the text eats JSON string contents, because `"@/*": ["./src/*"]` in
 * apps/web's paths map contains `/*` and the match then runs on until it finds
 * something that looks like a close. That is how the first version of this
 * helper failed, and it failed loudly, which is the only reason it was noticed.
 *
 * Only whole-line comments are removed, which is the form every tsconfig here
 * actually uses. A trailing comment after a value would survive and break the
 * parse, and that is the right outcome: a parse error is a visible failure,
 * whereas silently mangling the config would make this guard pass over a file it
 * could not read.
 */
function parseJsonc(src: string): unknown {
  let inBlock = false
  const lines: string[] = []
  for (const line of src.split('\n')) {
    const trimmed = line.trim()
    if (inBlock) {
      if (trimmed.endsWith('*/')) inBlock = false
      continue
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.endsWith('*/')) inBlock = true
      continue
    }
    if (trimmed.startsWith('//')) continue
    lines.push(line)
  }
  return JSON.parse(lines.join('\n'))
}

interface TsConfig {
  include?: string[]
}

/** Every top-level directory of a package that contains TypeScript. */
function tsDirs(pkgDir: string): string[] {
  return readdirSync(pkgDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !IGNORED.has(e.name))
    .map((e) => e.name)
    .filter((name) => {
      const dir = path.join(pkgDir, name)
      const stack = [dir]
      while (stack.length) {
        const current = stack.pop() as string
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          if (entry.isDirectory() && !IGNORED.has(entry.name)) stack.push(path.join(current, entry.name))
          else if (/\.tsx?$/.test(entry.name)) return true
        }
      }
      return false
    })
}

/**
 * Every directory covered by any tsconfig in the package.
 *
 * Two include shapes are in use here and both have to be understood, or the
 * guard accuses a package that is fully covered. apps/worker names directories
 * (`["src"]`); apps/web uses a recursive glob (`["**\/*.ts", "**\/*.tsx"]`),
 * which covers the whole package. A pattern beginning `**` is therefore total,
 * and `EVERYTHING` stands for that rather than being enumerated.
 */
const EVERYTHING = '**'

function includedDirs(pkgDir: string): Set<string> {
  const out = new Set<string>()
  for (const entry of readdirSync(pkgDir)) {
    if (!/^tsconfig.*\.json$/.test(entry)) continue
    const cfg = parseJsonc(readFileSync(path.join(pkgDir, entry), 'utf8')) as TsConfig
    for (const inc of cfg.include ?? []) {
      const normalized = inc.replace(/^\.\//, '')
      if (normalized.startsWith('**')) {
        out.add(EVERYTHING)
        continue
      }
      out.add(normalized.replace(/\/.*$/, ''))
    }
  }
  return out
}

describe('typecheck coverage', () => {
  const packages = workspacePackages().filter((p) => existsSync(path.join(p.dir, 'tsconfig.json')))

  it('finds packages with a tsconfig, so it is asserting something', () => {
    expect(packages.length).toBeGreaterThan(0)
  })

  for (const pkg of packages) {
    const who = pkg.name ?? path.relative(REPO_ROOT, pkg.dir)

    it(`${who} typechecks every directory that holds TypeScript`, () => {
      const included = includedDirs(pkg.dir)
      const missing = included.has(EVERYTHING) ? [] : tsDirs(pkg.dir).filter((d) => !included.has(d))

      expect(
        missing,
        `these directories in ${who} hold TypeScript that no tsconfig includes, so nothing typechecks them:\n  ${missing.join('\n  ')}`,
      ).toEqual([])
    })
  }

  // The command has to actually RUN the extra config. A tsconfig that includes
  // the directory but is never invoked typechecks exactly as much as no config
  // at all, and would satisfy the check above (L3).
  it('runs every tsconfig it declares', () => {
    for (const pkg of packages) {
      const configs = readdirSync(pkg.dir).filter((f) => /^tsconfig\..+\.json$/.test(f))
      if (configs.length === 0) continue
      const script = pkg.scripts?.typecheck ?? ''
      for (const cfg of configs) {
        expect(
          script,
          `${pkg.name ?? pkg.dir} has ${cfg} but its typecheck script never runs it`,
        ).toContain(cfg)
      }
    }
  })
})
