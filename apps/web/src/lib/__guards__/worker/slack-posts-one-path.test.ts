import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WORKER_SRC, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

/**
 * Every Slack alert goes out through postMessage, which adds the outage line
 * (#2061).
 *
 * Dan's decision (2026-10-14): while the database outage is open, every other
 * alert a scheduled tick posts carries one line naming it. That line is added in
 * ONE place, postMessage in lib/slack.ts (L621), and is only as complete as the
 * claim that every alert reaches Slack through it. So this fails when:
 *
 * - any worker source outside lib/slack.ts names Slack's post method, which is
 *   a post that would skip the line;
 * - inside lib/slack.ts the post method is named outside deliverMessage and the
 *   thread reply (a reply sits under its parent, which carried the line);
 * - deliverMessage, which posts with no line, is reached from anything but
 *   postMessage and the database owner's private path;
 * - that private path is exported, or reached from anything but the owner's own
 *   page and all-clear, the only messages the decision leaves the line off;
 * - the scheduled handler starts its jobs outside runInScheduledTick, or the
 *   tick's client stops attaching what the line is read with, either of which
 *   would leave every scheduled alert without it.
 *
 * Seen red against the planted sources in the last tests here, kept so the
 * check stays proven.
 */

const SLACK = 'lib/slack.ts'
const POST_METHOD = /chat\.postMessage/

const rel = (full: string) => path.relative(WORKER_SRC, full).replace(/\\/g, '/')
const read = (r: string) => sanitizeSource(readFileSync(path.join(WORKER_SRC, r), 'utf8'), { blankStrings: false })

/** The top level function each match of `re` sits in, by the nearest declaration above it. */
export function functionsUsing(source: string, re: RegExp): string[] {
  const decls = [...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)].map((m) => ({ at: m.index ?? 0, name: m[1] }))
  const global = new RegExp(re.source, 'g')
  return [...source.matchAll(global)].map((m) => {
    const before = decls.filter((d) => d.at <= (m.index ?? 0))
    return before.length ? before[before.length - 1].name : '<top level>'
  })
}

const sorted = (xs: string[]) => [...new Set(xs)].sort()

/** Calls of `name(` that are not its own declaration. */
const callsOf = (name: string) => new RegExp(`(?<!function\\s+)\\b${name}\\(`)

describe('every Slack alert is posted through postMessage (#2061)', () => {
  const slack = read(SLACK)

  it('names the post method nowhere in worker source but lib/slack.ts', () => {
    // listTsFiles already leaves out test files and __tests__ folders, whose
    // Slack doubles legitimately name the method.
    const outside = listTsFiles(WORKER_SRC)
      .map(rel)
      .filter((r) => r !== SLACK)
      .filter((r) => POST_METHOD.test(read(r)))
    expect(outside).toEqual([])
  })

  it('names it in lib/slack.ts only in deliverMessage and the thread reply', () => {
    expect(sorted(functionsUsing(slack, POST_METHOD))).toEqual(['deliverMessage', 'sendThreadReply'])
  })

  it('reaches deliverMessage only from postMessage and the owner path', () => {
    expect(sorted(functionsUsing(slack, callsOf('deliverMessage')))).toEqual(['postMessage', 'postOutageOwnerMessage'])
  })

  it('keeps the owner path private and used only by the owner page and its all-clear', () => {
    expect(slack).not.toMatch(/export\s+(?:async\s+)?function\s+postOutageOwnerMessage/)
    expect(sorted(functionsUsing(slack, callsOf('postOutageOwnerMessage')))).toEqual([
      'sendDatabaseRecoveredAlert',
      'sendDatabaseUnreachableAlert',
      'sendDatabaseUnreachableThroughCloudflare',
    ])
  })

  it('adds the outage line in postMessage', () => {
    expect(functionsUsing(slack, /openOutageForPost\(/)).toEqual(['postMessage'])
  })
})

describe('the scheduled tick carries the outage line context (#2061)', () => {
  it('starts every job of a tick inside runInScheduledTick', () => {
    const index = read('index.ts')
    const starts = [...index.matchAll(/scheduledJobs\.start\(/g)]
    expect(starts).toHaveLength(1)
    expect(index).toMatch(/runInScheduledTick\(\(\)\s*=>\s*scheduledJobs\.start\(/)
  })

  it('attaches the tick client to the context where the client is built', () => {
    expect(functionsUsing(read('lib/scheduled-slack.ts'), /attachOutageNotice\(/)).toEqual(['createScheduledSupabaseClient'])
  })
})

describe('the guard itself', () => {
  it('names the function a planted direct post sits in', () => {
    const planted = [
      'export async function sendSneakyAlert(token: string) {',
      "  await fetch('https://slack.com/api/chat.postMessage', { method: 'POST' })",
      '}',
      'async function deliverMessage() {',
      "  await fetch('https://slack.com/api/chat.postMessage')",
      '}',
    ].join('\n')
    expect(sorted(functionsUsing(planted, POST_METHOD))).toEqual(['deliverMessage', 'sendSneakyAlert'])
  })

  it('sees a call of the owner path from another sender, and not the declaration', () => {
    const planted = [
      'function postOutageOwnerMessage(a: string) {',
      '  return deliverMessage(a)',
      '}',
      'export async function sendHeartbeat() {',
      '  return postOutageOwnerMessage(x)',
      '}',
    ].join('\n')
    expect(functionsUsing(planted, callsOf('postOutageOwnerMessage'))).toEqual(['sendHeartbeat'])
  })
})
