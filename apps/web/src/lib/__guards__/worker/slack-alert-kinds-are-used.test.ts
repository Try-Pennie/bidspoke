/**
 * Every Slack alert kind is a live name (#2948).
 *
 * Every Worker alert names a fixed kind from SLACK_ALERT_KINDS
 * (apps/worker/src/lib/slack-post-outcome.ts), which the post outcome line
 * records and the tail Worker copies into slack_post_outcomes.alert_kind. The
 * compiler holds every sender to naming one from the list, but nothing holds
 * the list to its senders: a kind left behind when its alert is removed or
 * renamed would read as an alert that simply never posts, and a name listed
 * twice would make the list look longer than the alerts it covers. So this
 * holds every listed kind to being named, as a quoted literal outside comments,
 * by at least one non test Worker source file other than the list itself, and
 * the list to having no duplicates.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

const LIST_FILE = path.join(WORKER_SRC, 'lib', 'slack-post-outcome.ts')

/** The names between `SLACK_ALERT_KINDS = [` and `] as const`, in order, duplicates kept. */
function listedKinds(src: string): string[] {
  const code = sanitizeSource(src, { blankStrings: false })
  const start = code.search(/\bSLACK_ALERT_KINDS\s*=\s*\[/)
  if (start === -1) return []
  const open = code.indexOf('[', start)
  const close = code.indexOf(']', open)
  return [...code.slice(open + 1, close).matchAll(/'([^']*)'/g)].map((m) => m[1])
}

/**
 * Every quoted literal shaped like a kind in code, comments ignored. One pass
 * per file, never one per kind (L297): there are over a hundred kinds.
 */
function namedIn(sources: readonly string[]): Set<string> {
  const named = new Set<string>()
  for (const src of sources) {
    for (const m of sanitizeSource(src, { blankStrings: false }).matchAll(/(['"`])([a-z0-9]+(?:-[a-z0-9]+)*)\1/g)) named.add(m[2])
  }
  return named
}

function senderSources(): string[] {
  return listTsFiles(WORKER_SRC)
    .filter((file) => path.resolve(file) !== path.resolve(LIST_FILE))
    .filter((file) => {
      const rel = path.relative(WORKER_SRC, file).replace(/\\/g, '/')
      return !rel.includes('__tests__/') && !rel.endsWith('.test.ts')
    })
    .map((file) => readFileSync(file, 'utf8'))
}

describe('every Slack alert kind is named by a sender (#2948)', () => {
  const kinds = listedKinds(readFileSync(LIST_FILE, 'utf8'))

  it('reads the list, so the checks below are not passing on nothing (L1)', () => {
    expect(kinds.length).toBeGreaterThan(50)
    expect(kinds).toContain('http-money-host')
  })

  it('lists no kind twice', () => {
    const twice = kinds.filter((k, i) => kinds.indexOf(k) !== i)
    expect(twice, `listed more than once in SLACK_ALERT_KINDS: ${twice.join(', ')}`).toEqual([])
  })

  it('names no kind that no sender uses', () => {
    const named = namedIn(senderSources())
    const dead = kinds.filter((k) => !named.has(k))
    expect(dead, `in SLACK_ALERT_KINDS but named by no Worker sender: ${dead.join(', ')}`).toEqual([])
  })

  it('finds a duplicate and a dead name in a list made to hold them', () => {
    const list = `export const SLACK_ALERT_KINDS = [\n  // 'commented-out',\n  'used-kind',\n  'dead-kind',\n  'used-kind',\n] as const\n`
    const found = listedKinds(list)
    expect(found).toEqual(['used-kind', 'dead-kind', 'used-kind'])
    const sender = `// 'dead-kind' is only in a comment here\npostMessage(t, c, b, x, 'used-kind')\n`
    expect(namedIn([sender]).has('used-kind')).toBe(true)
    expect(namedIn([sender]).has('dead-kind')).toBe(false)
    // A longer kind that merely starts with a listed one is not a use of it.
    expect(namedIn([`postMessage(t, c, b, x, 'used-kind-all-clear')`]).has('used-kind')).toBe(false)
  })
})
