/**
 * Every Slack post the Worker makes logs its outcome (#2364).
 *
 * The refusal check reads only what the tail Worker copies from the
 * `[slack] post outcome` line, and that line is written in exactly two places:
 * deliverMessage (every alert) and sendThreadReply (the summary under a failure
 * alert), both in lib/slack.ts. A third chat.postMessage anywhere else in the
 * Worker would post without writing it, and its refusals would be invisible to
 * the check, which would read them as Slack taking every post. So this holds
 * the only chat.postMessage calls in apps/worker/src to those two functions,
 * and holds each of them to calling the shared logger.
 *
 * The ops Slack action (packages/service-catalogue) posts through its own
 * client for ops workflows, not alerts, and is outside this check.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC, consumeParens, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

const SLACK = path.join(WORKER_SRC, 'lib', 'slack.ts')
const POSTERS = ['deliverMessage', 'sendThreadReply'] as const

/** The source of each chat.postMessage call site, as `file:function`. */
function postSites(): string[] {
  const sites: string[] = []
  for (const file of listTsFiles(WORKER_SRC)) {
    const rel = path.relative(WORKER_SRC, file).replace(/\\/g, '/')
    if (rel.includes('__tests__/') || rel.endsWith('.test.ts')) continue
    const src = sanitizeSource(readFileSync(file, 'utf8'))
    for (const m of src.matchAll(/\bchat\s*\.\s*postMessage\s*\(/g)) {
      const before = src.slice(0, m.index)
      const fn = [...before.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)].at(-1)?.[1] ?? '(top level)'
      sites.push(`${rel}:${fn}`)
    }
  }
  return sites.sort()
}

/** The body of a top level function in slack.ts. */
function bodyOf(name: string): string {
  const src = sanitizeSource(readFileSync(SLACK, 'utf8'))
  const start = src.search(new RegExp(`(?:export\\s+)?async\\s+function\\s+${name}\\s*\\(`))
  expect(start, `${name} is no longer an async function in lib/slack.ts`).toBeGreaterThan(-1)
  const paramsEnd = consumeParens(src, src.indexOf('(', start))
  const open = src.indexOf('{', paramsEnd)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
  }
  throw new Error(`unbalanced braces in ${name}`)
}

describe('every Worker Slack post logs its outcome (#2364)', () => {
  it('the only chat.postMessage calls are in deliverMessage and sendThreadReply', () => {
    expect(postSites()).toEqual(['lib/slack.ts:deliverMessage', 'lib/slack.ts:sendThreadReply'])
  })

  it.each(POSTERS)('%s writes the outcome line through the shared logger', (name) => {
    expect(bodyOf(name)).toMatch(/\blogSlackPostOutcome\s*\(/)
  })

  it('finds a stray post, so the check above is not passing on nothing (L1)', () => {
    const stray = `async function sendSomethingElse() { await client.chat.postMessage({ channel }) }`
    expect([...sanitizeSource(stray).matchAll(/\bchat\s*\.\s*postMessage\s*\(/g)]).toHaveLength(1)
  })
})
