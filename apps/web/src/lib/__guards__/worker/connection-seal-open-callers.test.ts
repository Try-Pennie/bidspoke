import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, WORKER_SRC, listFiles, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

/**
 * Who may open a sealed ops connection login (#2335, phase 5 of #1689; plan:
 * discussion #2329, part 2).
 *
 * `open` from @bidspoke/connection-seal turns an envelope into a plaintext
 * login. Every place that holds one is a place a login can leak from, so the
 * set is closed: a module may call `open` only if it is listed below with its
 * reason. Later PRs of this phase add the others the plan names (verify, which
 * must compare the sealed client id with the declaration; resealConnections,
 * which must open in order to reseal; ConnectionTokenObject, which holds the
 * refresh token; the restore drill script), each with its own reason, in the
 * PR that creates it. An entry for a file that does not exist, or that no
 * longer opens anything, fails here too (L96), so the list stays the truth.
 *
 * What counts as reaching `open`, outside the listed modules: a value import
 * of it (aliased or not), a namespace import, a re-export, or a dynamic import
 * or require of the package, because the scan cannot follow any of those to
 * see what is called. `seal` and the types are free to import anywhere.
 *
 * It also refuses `console.` in the connection modules
 * (apps/worker/src/ops/connections): they hold opened logins and tokens, and
 * the ops Worker's console feeds Workers Logs (wrangler.ops.toml:
 * invocation_logs, head_sampling_rate 1) and the tail consumer. That ban is not
 * the whole protection (finding F120): an uncaught exception's message reaches
 * both with no console call, which connectionFetch answers by throwing only
 * refusals built from names (see its canary test).
 *
 * Scanned: the Worker's source, every package but the seal itself, and the
 * scripts outside apps/worker/src that the Worker scan cannot see (the repo's
 * scripts/ and apps/worker/scripts), where the restore drill will live.
 * Comments are stripped; tests are not scanned.
 */

const ALLOWED_OPENERS: Readonly<Record<string, string>> = {
  'apps/worker/src/ops/connections/connection-fetch.ts':
    'connectionFetch: every connection bound request (steps, lookups, Reconnect, and the scheduled still valid and sf_limits reads) reaches the credential only through it',
}

const CONNECTION_MODULES = path.join(WORKER_SRC, 'ops/connections')

const SPECIFIER = String.raw`['"](?:@bidspoke/connection-seal(?:/[^'"]*)?|[^'"]*packages/connection-seal(?:/[^'"]*)?)['"]`
const NAMED_IMPORT = new RegExp(String.raw`\bimport\s+(type\s+)?\{([^}]*)\}\s*from\s*` + SPECIFIER, 'g')
const NAMESPACE_IMPORT = new RegExp(String.raw`\bimport\s+(?:type\s+)?\*\s+as\s+\w+\s+from\s*` + SPECIFIER, 'g')
const DEFAULT_IMPORT = new RegExp(String.raw`\bimport\s+\w+\s*(?:,\s*\{[^}]*\})?\s*from\s*` + SPECIFIER, 'g')
const REEXPORT = new RegExp(String.raw`\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s*` + SPECIFIER, 'g')
const DYNAMIC = new RegExp(String.raw`\b(?:import|require)\s*\(\s*` + SPECIFIER, 'g')

/** How a source reaches `open` from the seal, if it does. */
export function reachesOpen(source: string): string[] {
  const src = sanitizeSource(source, { blankStrings: false })
  const found: string[] = []
  for (const m of src.matchAll(NAMED_IMPORT)) {
    if (m[1]) continue
    const names = m[2].split(',').map((n) => n.trim()).filter(Boolean)
    if (names.some((n) => /^open(\s+as\s+\w+)?$/.test(n))) found.push('imports open')
  }
  if ([...src.matchAll(NAMESPACE_IMPORT)].length > 0) found.push('imports the seal as a namespace')
  if ([...src.matchAll(DEFAULT_IMPORT)].length > 0) found.push('imports the seal\'s default')
  for (const m of src.matchAll(REEXPORT)) {
    if (/^export\s+type\b/.test(m[0])) continue
    found.push('re-exports from the seal')
  }
  if ([...src.matchAll(DYNAMIC)].length > 0) found.push('loads the seal dynamically')
  return found
}

/** console.* in a connection module. */
export function usesConsole(source: string): boolean {
  return /\bconsole\s*\??\.\s*\w+/.test(sanitizeSource(source))
}

const rel = (full: string) => path.relative(REPO_ROOT, full).replace(/\\/g, '/')

function scriptFiles(root: string): string[] {
  if (!existsSync(root)) return []
  return listFiles(root, { exts: ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'] })
}

const packageRoots = readdirSync(path.join(REPO_ROOT, 'packages'))
  .filter((name) => name !== 'connection-seal')
  .map((name) => path.join(REPO_ROOT, 'packages', name, 'src'))
  .filter((root) => existsSync(root))

const files = [
  ...listTsFiles(WORKER_SRC),
  ...packageRoots.flatMap((root) => listTsFiles(root)),
  ...scriptFiles(path.join(REPO_ROOT, 'scripts')),
  ...scriptFiles(path.join(REPO_ROOT, 'apps/worker/scripts')),
].map((full) => ({ rel: rel(full), full }))

describe('only the listed modules open a sealed ops login (#2335)', () => {
  it('no other Worker, package or script source reaches open', () => {
    const offenders = files
      .filter((f) => !Object.hasOwn(ALLOWED_OPENERS, f.rel))
      .map((f) => ({ file: f.rel, found: reachesOpen(readFileSync(f.full, 'utf8')) }))
      .filter((o) => o.found.length > 0)
    expect(offenders).toEqual([])
  })

  it('every listed module exists, opens, and says why it may', () => {
    for (const [file, reason] of Object.entries(ALLOWED_OPENERS)) {
      const full = path.join(REPO_ROOT, file)
      expect(existsSync(full), `${file} is listed and does not exist`).toBe(true)
      expect(reachesOpen(readFileSync(full, 'utf8')), `${file} is listed and does not open anything`).toContain('imports open')
      expect(reason.length, `${file} needs its reason`).toBeGreaterThan(20)
    }
  })

  it('no connection module writes to the console', () => {
    const modules = listTsFiles(CONNECTION_MODULES).map((full) => ({ file: rel(full), full }))
    expect(modules.length).toBeGreaterThanOrEqual(4)
    expect(modules.filter((m) => usesConsole(readFileSync(m.full, 'utf8'))).map((m) => m.file)).toEqual([])
  })

  it('scans every root, so it cannot pass by reading nothing (L98)', () => {
    expect(files.filter((f) => f.rel.startsWith('apps/worker/src/')).length).toBeGreaterThan(100)
    expect(files.some((f) => f.rel.startsWith('packages/service-catalogue/src/'))).toBe(true)
    expect(files.some((f) => f.rel.startsWith('scripts/'))).toBe(true)
    expect(files.some((f) => f.rel.startsWith('apps/worker/scripts/'))).toBe(true)
    expect(files.some((f) => f.rel.startsWith('packages/connection-seal/'))).toBe(false)
  })

  it('fails on each planted way of reaching open, and not on seal, a type or a comment (seen red)', () => {
    const pkg = `'@bidspoke/connection-seal'`
    expect(reachesOpen(`import { open } from ${pkg}`)).toEqual(['imports open'])
    expect(reachesOpen(`import { seal, open as unseal, type KeyRing } from ${pkg}`)).toEqual(['imports open'])
    expect(reachesOpen(`import { open } from '../../../../packages/connection-seal/src/seal'`)).toEqual(['imports open'])
    expect(reachesOpen(`import * as cs from ${pkg}\ncs.open(ring, env, aad)`)).toEqual(['imports the seal as a namespace'])
    expect(reachesOpen(`export { open } from ${pkg}`)).toEqual(['re-exports from the seal'])
    expect(reachesOpen(`export * from ${pkg}`)).toEqual(['re-exports from the seal'])
    expect(reachesOpen(`const cs = await import(${pkg})`)).toEqual(['loads the seal dynamically'])
    expect(reachesOpen(`const cs = require("@bidspoke/connection-seal")`)).toEqual(['loads the seal dynamically'])
    // Not openers.
    expect(reachesOpen(`import { seal, CURRENT_OPS_KID } from ${pkg}`)).toEqual([])
    expect(reachesOpen(`import type { SealedEnvelope, KeyRing } from ${pkg}`)).toEqual([])
    expect(reachesOpen(`export type { SealedEnvelope } from ${pkg}`)).toEqual([])
    expect(reachesOpen(`// import { open } from ${pkg}\nconst x = 1`)).toEqual([])
    expect(reachesOpen(`import { openDialog } from './dialog'`)).toEqual([])
  })

  it('fails on a planted console call in a connection module, and not on one in a comment or a string (seen red)', () => {
    expect(usesConsole(`export function f() { console.log(token) }`)).toBe(true)
    expect(usesConsole(`console.error(JSON.stringify({ event: 'x' }))`)).toBe(true)
    expect(usesConsole(`globalThis.console?.warn('x')`)).toBe(true)
    expect(usesConsole(`// never console.log here\nconst x = 'console.log'`)).toBe(false)
  })
})
