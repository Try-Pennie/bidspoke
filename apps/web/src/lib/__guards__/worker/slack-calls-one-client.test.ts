import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, WORKER_SRC, listFiles, sanitizeSource, workspacePackages } from '../../__tests__/_scan-utils'

/**
 * Every Slack Web API call goes through createSlackClient (#2331 phase 1b,
 * #1689 D3), which lives in packages/slack-client so the Worker and the
 * service catalogue's ops Slack actions build their clients in the same place
 * (#2337).
 *
 * createSlackClient (packages/slack-client/src/index.ts) is the one place a
 * Slack client is built, with the library's rate limit retry handler off (it
 * sleeps inside the request for whatever Retry-After says) and debug logging
 * off (at DEBUG it prints request bodies, client secrets included). Those two
 * are asserted on what a built client DOES by the package's own suite
 * (packages/slack-client/src/__tests__/client.test.ts). A hand written fetch to
 * slack.com/api, or a client built anywhere else, gets neither guarantee, so
 * this fails on any of these outside the factory:
 *
 * - a string naming `slack.com/api` (a fetch, a URL, a constant holding it);
 * - `new SlackAPIClient(`, anywhere but the package's index.ts, which may
 *   build exactly one, inside createSlackClient;
 * - any import of slack-web-api-client (static, dynamic or require, a type
 *   only import included) anywhere but that same file. The package re-exports
 *   the types a caller needs, so the library has one importer, and an alias
 *   cannot hide a second construction;
 * - a package.json other than packages/slack-client's declaring the library,
 *   or that one declaring it at anything but an exact version, so there is one
 *   pinned copy and one place it is pinned.
 *
 * It scans the src folder of every workspace package (apps/* and packages/*),
 * enumerated from pnpm-workspace.yaml rather than listed here (L96), so the
 * Worker, the service catalogue runtime where the ops Slack actions will live
 * (Phase 7), and any package added later are all covered without an edit.
 * Comments are stripped, so a comment naming the API is not a call; tests are
 * not scanned.
 */

const PACKAGE_DIR = 'packages/slack-client'
const HOME = `${PACKAGE_DIR}/src/index.ts`
const LIBRARY = 'slack-web-api-client'

const API_HOST = /slack\.com\/api/
const NEW_CLIENT = /\bnew\s+SlackAPIClient\s*\(/g
/** Any import of the library: `from '...'`, `import '...'`, `import('...')`, `require('...')`. */
const LIBRARY_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"`]slack-web-api-client(?:\/[^'"`]*)?['"`]/

/** What in `source` calls Slack other than through the factory. `home` relaxes only the factory's own import and its one construction. */
export function slackCallsOutsideFactory(source: string, home = false): string[] {
  const src = sanitizeSource(source, { blankStrings: false })
  const found: string[] = []
  if (API_HOST.test(src)) found.push('names slack.com/api')
  const news = [...src.matchAll(NEW_CLIENT)]
  if (home) {
    const start = src.indexOf('export function createSlackClient(')
    const end = start < 0 ? -1 : src.indexOf('\n}', start)
    const inside = news.filter((m) => start >= 0 && (m.index ?? 0) > start && (m.index ?? 0) < end)
    if (news.length !== 1 || inside.length !== 1) found.push(`builds ${news.length} SlackAPIClient, ${inside.length} inside createSlackClient`)
  } else {
    if (news.length > 0) found.push('builds a SlackAPIClient')
    if (LIBRARY_IMPORT.test(src)) found.push(`imports ${LIBRARY}`)
  }
  return found
}

/** What in a package.json, at `relativeDir`, breaks the one pinned copy. */
export function libraryDeclarationProblems(relativeDir: string, manifest: Record<string, unknown>): string[] {
  const found: string[] = []
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = manifest[field] as Record<string, string> | undefined
    const version = deps?.[LIBRARY]
    if (version === undefined) continue
    if (relativeDir !== PACKAGE_DIR) found.push(`declares ${LIBRARY} in ${field}`)
    else if (field !== 'dependencies') found.push(`declares ${LIBRARY} in ${field}, not dependencies`)
    else if (!/^\d+\.\d+\.\d+$/.test(version)) found.push(`declares ${LIBRARY} at ${version}, not an exact version`)
  }
  return found
}

const packages = workspacePackages()
const rel = (full: string) => path.relative(REPO_ROOT, full).replace(/\\/g, '/')
const files = packages
  .map((pkg) => path.join(pkg.dir, 'src'))
  .filter((src) => existsSync(src))
  .flatMap((src) => listFiles(src))
  .map((full) => ({ rel: rel(full), full }))
const manifests = [
  { relativeDir: '.', file: path.join(REPO_ROOT, 'package.json') },
  ...packages.map((pkg) => ({ relativeDir: pkg.relativeDir, file: path.join(pkg.dir, 'package.json') })),
]

describe('every Slack call goes through createSlackClient (#2331, #2337)', () => {
  it('no workspace source calls Slack outside the factory', () => {
    const offenders = files
      .filter((f) => f.rel !== HOME)
      .map((f) => ({ file: f.rel, found: slackCallsOutsideFactory(readFileSync(f.full, 'utf8')) }))
      .filter((o) => o.found.length > 0)
    expect(offenders).toEqual([])
  })

  it('the factory builds exactly one client, inside createSlackClient', () => {
    expect(slackCallsOutsideFactory(readFileSync(path.join(REPO_ROOT, HOME), 'utf8'), true)).toEqual([])
  })

  it('only packages/slack-client declares the library, at one exact version', () => {
    const offenders = manifests
      .map((m) => ({ dir: m.relativeDir, found: libraryDeclarationProblems(m.relativeDir, JSON.parse(readFileSync(m.file, 'utf8')) as Record<string, unknown>) }))
      .filter((o) => o.found.length > 0)
    expect(offenders).toEqual([])
    const own = JSON.parse(readFileSync(path.join(REPO_ROOT, PACKAGE_DIR, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    expect(own.dependencies?.[LIBRARY]).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('scans the factory, the Worker and the service catalogue, so it cannot pass by reading nothing', () => {
    expect(files.some((f) => f.rel === HOME)).toBe(true)
    expect(files.some((f) => f.rel.startsWith('packages/service-catalogue/src/'))).toBe(true)
    expect(files.filter((f) => f.full.startsWith(WORKER_SRC + path.sep)).length).toBeGreaterThan(100)
    expect(manifests.some((m) => m.relativeDir === 'apps/worker')).toBe(true)
    expect(manifests.some((m) => m.relativeDir === 'packages/service-catalogue')).toBe(true)
  })

  it('fails on each planted form, and not on a comment or a call through the package', () => {
    // Positive controls: what the senders did before #2331.
    expect(slackCallsOutsideFactory(`await fetch('https://slack.com/api/chat.postMessage', { method: 'POST' })`)).toEqual(['names slack.com/api'])
    expect(slackCallsOutsideFactory('const url = new URL("https://slack.com/api/conversations.list")')).toEqual(['names slack.com/api'])
    expect(slackCallsOutsideFactory('const BASE = `https://slack.com/api/`')).toEqual(['names slack.com/api'])
    expect(slackCallsOutsideFactory(`import { SlackAPIClient } from 'slack-web-api-client'\nconst c = new SlackAPIClient(token)`)).toEqual(['builds a SlackAPIClient', 'imports slack-web-api-client'])
    expect(slackCallsOutsideFactory(`import { SlackAPIClient as Client } from 'slack-web-api-client'\nconst c = new Client(token)`)).toEqual(['imports slack-web-api-client'])
    expect(slackCallsOutsideFactory(`import * as slack from "slack-web-api-client"\nconst c = new slack.SlackAPIClient(token)`)).toEqual(['imports slack-web-api-client'])
    expect(slackCallsOutsideFactory(`const { SlackAPIClient: C } = await import('slack-web-api-client')`)).toEqual(['imports slack-web-api-client'])
    expect(slackCallsOutsideFactory(`const lib = require('slack-web-api-client')`)).toEqual(['imports slack-web-api-client'])
    expect(slackCallsOutsideFactory(`import type { AnyMessageBlock } from 'slack-web-api-client'`)).toEqual(['imports slack-web-api-client'])
    expect(slackCallsOutsideFactory(`import { SlackAPIError } from 'slack-web-api-client/dist/errors'`)).toEqual(['imports slack-web-api-client'])
    // Not calls: a comment, and the way every caller reaches Slack.
    expect(slackCallsOutsideFactory(`// posts to slack.com/api/chat.postMessage through createSlackClient\nconst c = createSlackClient(conn)`)).toEqual([])
    expect(slackCallsOutsideFactory(`import { createSlackClient, type AnyMessageBlock } from '@bidspoke/slack-client'`)).toEqual([])
    // The home: one construction inside the factory passes; a second anywhere fails.
    const factory = `import { SlackAPIClient } from 'slack-web-api-client'\nexport function createSlackClient(c: { bot_token: string }) {\n  return new SlackAPIClient(c.bot_token, {})\n}\n`
    expect(slackCallsOutsideFactory(factory, true)).toEqual([])
    expect(slackCallsOutsideFactory(`${factory}export const other = new SlackAPIClient('x')\n`, true)).toEqual(['builds 2 SlackAPIClient, 1 inside createSlackClient'])
  })

  it('fails on a second declaration of the library, or a range in the package', () => {
    expect(libraryDeclarationProblems('apps/worker', { dependencies: { [LIBRARY]: '1.1.14' } })).toEqual([`declares ${LIBRARY} in dependencies`])
    expect(libraryDeclarationProblems('packages/service-catalogue', { devDependencies: { [LIBRARY]: '1.1.14' } })).toEqual([`declares ${LIBRARY} in devDependencies`])
    expect(libraryDeclarationProblems(PACKAGE_DIR, { dependencies: { [LIBRARY]: '^1.1.14' } })).toEqual([`declares ${LIBRARY} at ^1.1.14, not an exact version`])
    expect(libraryDeclarationProblems(PACKAGE_DIR, { peerDependencies: { [LIBRARY]: '1.1.14' } })).toEqual([`declares ${LIBRARY} in peerDependencies, not dependencies`])
    expect(libraryDeclarationProblems(PACKAGE_DIR, { dependencies: { [LIBRARY]: '1.1.14' } })).toEqual([])
    expect(libraryDeclarationProblems('apps/worker', { dependencies: { '@bidspoke/slack-client': 'workspace:*' } })).toEqual([])
  })
})
