import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, WORKER_SRC, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

/**
 * Every Slack Web API call goes through createSlackClient (#2331 phase 1b,
 * #1689 D3).
 *
 * createSlackClient (apps/worker/src/lib/slack-client.ts) is the one place a
 * Slack client is built, with the library's rate limit retry handler off (it
 * sleeps inside the request for whatever Retry-After says) and debug logging
 * off (at DEBUG it prints request bodies, client secrets included). A hand
 * written fetch to slack.com/api, or a client built anywhere else, gets
 * neither guarantee, so this fails on either outside the factory:
 *
 * - a string naming `slack.com/api` (a fetch, a URL, a constant holding it);
 * - `new SlackAPIClient(`, or a value import of SlackAPIClient (an alias would
 *   hide the `new`), anywhere but slack-client.ts, which may build exactly one,
 *   inside createSlackClient.
 *
 * It scans the Worker's source and packages/service-catalogue, where the ops
 * Slack catalogue actions will live (Phase 7). Comments are stripped, so a
 * comment naming the API is not a call; tests are not scanned.
 */

const HOME = 'apps/worker/src/lib/slack-client.ts'
const ROOTS = [WORKER_SRC, path.join(REPO_ROOT, 'packages/service-catalogue/src')]

const API_HOST = /slack\.com\/api/
const NEW_CLIENT = /\bnew\s+SlackAPIClient\s*\(/g
/** A value (not type only) import of SlackAPIClient from the library. */
const VALUE_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]slack-web-api-client['"]/g

/** What in `source` calls Slack other than through the factory. `home` relaxes only the one construction inside createSlackClient. */
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
    for (const m of src.matchAll(VALUE_IMPORT)) {
      const names = m[1].split(',').map((n) => n.trim())
      if (!/^import\s+type\b/.test(m[0]) && names.some((n) => /^SlackAPIClient\b/.test(n))) found.push('imports SlackAPIClient as a value')
    }
  }
  return found
}

const rel = (full: string) => path.relative(REPO_ROOT, full).replace(/\\/g, '/')
const files = ROOTS.flatMap((root) => listTsFiles(root)).map((full) => ({ rel: rel(full), full }))

describe('every Slack call goes through createSlackClient (#2331)', () => {
  it('no Worker or service-catalogue source calls Slack outside the factory', () => {
    const offenders = files
      .filter((f) => f.rel !== HOME)
      .map((f) => ({ file: f.rel, found: slackCallsOutsideFactory(readFileSync(f.full, 'utf8')) }))
      .filter((o) => o.found.length > 0)
    expect(offenders).toEqual([])
  })

  it('the factory builds exactly one client, inside createSlackClient', () => {
    expect(slackCallsOutsideFactory(readFileSync(path.join(REPO_ROOT, HOME), 'utf8'), true)).toEqual([])
  })

  it('scans both roots, so it cannot pass by reading nothing', () => {
    expect(files.some((f) => f.rel === HOME)).toBe(true)
    expect(files.some((f) => f.rel.startsWith('packages/service-catalogue/src/'))).toBe(true)
    expect(files.filter((f) => f.rel.startsWith('apps/worker/src/')).length).toBeGreaterThan(100)
  })

  it('fails on each planted form, and not on a comment or a type import', () => {
    // Positive controls: what the senders did before #2331.
    expect(slackCallsOutsideFactory(`await fetch('https://slack.com/api/chat.postMessage', { method: 'POST' })`)).toEqual(['names slack.com/api'])
    expect(slackCallsOutsideFactory('const url = new URL("https://slack.com/api/conversations.list")')).toEqual(['names slack.com/api'])
    expect(slackCallsOutsideFactory('const BASE = `https://slack.com/api/`')).toEqual(['names slack.com/api'])
    expect(slackCallsOutsideFactory(`import { SlackAPIClient } from 'slack-web-api-client'\nconst c = new SlackAPIClient(token)`)).toEqual(['builds a SlackAPIClient', 'imports SlackAPIClient as a value'])
    expect(slackCallsOutsideFactory(`import { SlackAPIClient as Client } from 'slack-web-api-client'\nconst c = new Client(token)`)).toEqual(['imports SlackAPIClient as a value'])
    // Not calls.
    expect(slackCallsOutsideFactory(`// posts to slack.com/api/chat.postMessage through createSlackClient\nconst c = createSlackClient(conn)`)).toEqual([])
    expect(slackCallsOutsideFactory(`import type { SlackAPIClient } from 'slack-web-api-client'`)).toEqual([])
    expect(slackCallsOutsideFactory(`import { type SlackAPIClient, SlackAPIError } from 'slack-web-api-client'`)).toEqual([])
    // The home: one construction inside the factory passes; a second anywhere fails.
    const factory = `export function createSlackClient(c: { bot_token: string }) {\n  return new SlackAPIClient(c.bot_token, {})\n}\n`
    expect(slackCallsOutsideFactory(factory, true)).toEqual([])
    expect(slackCallsOutsideFactory(`${factory}export const other = new SlackAPIClient('x')\n`, true)).toEqual(['builds 2 SlackAPIClient, 1 inside createSlackClient'])
  })
})
