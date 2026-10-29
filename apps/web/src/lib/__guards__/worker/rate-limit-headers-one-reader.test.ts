/**
 * One reader of a rate limit's "come back at" headers on the ops Worker
 * (#1693 7.4).
 *
 * PR #2988 taught connectionFetch to honour the x-ratelimit-reset style
 * headers as well as Retry-After, held between 1 second and 1 hour, and to
 * count a header it cannot read. The minters' token endpoint read only
 * Retry-After, and counted nothing, because it had its own reading. Now both
 * call rateLimitRetryAt in apps/worker/src/ops/connections/rate-limit-headers.ts,
 * so the two cannot drift apart again.
 *
 * Outside comments, in the ops Worker's source (tests are not scanned):
 *  - only the shared module names one of these headers as a string, so no
 *    module reads Retry-After or a reset header itself;
 *  - only the shared module declares the reader's functions, so no module
 *    keeps a local copy under the old names;
 *  - connectionFetch and the token endpoint each import rateLimitRetryAt from
 *    the shared module and call it.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WORKER_SRC, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

const SHARED = 'apps/worker/src/ops/connections/rate-limit-headers.ts'
const CALLERS: Readonly<Record<string, string>> = {
  'apps/worker/src/ops/connections/connection-fetch.ts': 'a step\'s or a lookup\'s own 429, or 503 with Retry-After',
  'apps/worker/src/ops/connections/minters/token-endpoint.ts': 'a minter\'s or the ConnectionTokenObject\'s token request answered 429',
}

const HEADER_LITERAL = /(['"`])\s*(?:retry-after|x-ratelimit-reset|x-rate-limit-reset|ratelimit-reset)\s*\1/i
const READER_DECLARATION = /\b(?:function\s*\*?\s*|(?:const|let|var)\s+)(retryAfterAt|rateLimitResetAt|rateLimitRetryAt|rateLimitWaitAt|clampedRetry)\b/

/** What a source does that only the shared reader may: name a header, or declare a reader. */
export function readsRateLimitHeadersItself(source: string): string[] {
  const code = sanitizeSource(source, { blankStrings: false })
  const found: string[] = []
  const literal = code.match(HEADER_LITERAL)
  if (literal) found.push(`names the header ${literal[0]}`)
  const declared = code.match(READER_DECLARATION)
  if (declared) found.push(`declares ${declared[1]}`)
  // A copy under a new name that reads through the shared module's own names.
  if (/\.get\(\s*RETRY_AFTER_HEADER\b/.test(code)) found.push('reads RETRY_AFTER_HEADER')
  if (/\bof\s+RATE_LIMIT_(?:RESET_)?HEADERS\b/.test(code)) found.push('walks the reset headers')
  return found
}

/** Whether a source imports rateLimitRetryAt, as a value, from the shared module, and calls it. */
export function callsSharedReader(source: string): boolean {
  const code = sanitizeSource(source, { blankStrings: false })
  const imported = /\bimport\s*\{([^}]*)\}\s*from\s*['"](?:\.\.?\/)+(?:connections\/)?rate-limit-headers['"]/.exec(code)
  if (imported === null) return false
  const names = imported[1].split(',').map((n) => n.trim())
  if (!names.includes('rateLimitRetryAt')) return false
  return /\brateLimitRetryAt\s*\(/.test(code.slice(imported.index + imported[0].length))
}

const OPS_SRC = path.join(WORKER_SRC, 'ops')
const rel = (full: string) => path.relative(REPO_ROOT, full).replace(/\\/g, '/')
const files = listTsFiles(OPS_SRC).map((full) => ({ rel: rel(full), source: readFileSync(full, 'utf8') }))

describe('one reader of rate limit headers on the ops Worker (#1693 7.4)', () => {
  it('scans the ops Worker\'s source, both callers and the shared module included (L98)', () => {
    expect(files.length).toBeGreaterThan(50)
    for (const f of [SHARED, ...Object.keys(CALLERS)]) expect(files.some((x) => x.rel === f), f).toBe(true)
  })

  it('the shared module names the headers and declares the reader', () => {
    expect(existsSync(path.join(REPO_ROOT, SHARED))).toBe(true)
    const found = readsRateLimitHeadersItself(readFileSync(path.join(REPO_ROOT, SHARED), 'utf8'))
    expect(found.some((f) => f.startsWith('names the header'))).toBe(true)
    expect(found.some((f) => f.startsWith('declares'))).toBe(true)
  })

  it('no other ops module reads a rate limit header itself or keeps a copy of the reader', () => {
    const offenders = files.filter((f) => f.rel !== SHARED).map((f) => ({ file: f.rel, found: readsRateLimitHeadersItself(f.source) })).filter((f) => f.found.length > 0)
    expect(offenders).toEqual([])
  })

  it('connectionFetch and the token endpoint each call the shared reader', () => {
    for (const [file, what] of Object.entries(CALLERS)) {
      expect(what.length).toBeGreaterThan(20)
      expect(callsSharedReader(readFileSync(path.join(REPO_ROOT, file), 'utf8')), `${file} (${what}) does not call rateLimitRetryAt from ${SHARED}`).toBe(true)
    }
  })

  it('catches each way a copy could come back', () => {
    expect(readsRateLimitHeadersItself("const at = res.headers.get('retry-after')")).toEqual(["names the header 'retry-after'"])
    expect(readsRateLimitHeadersItself('const h = headers.get("X-RateLimit-Reset")')).toEqual(['names the header "X-RateLimit-Reset"'])
    expect(readsRateLimitHeadersItself('function retryAfterAt(header: string, now: number) { return null }')).toEqual(['declares retryAfterAt'])
    expect(readsRateLimitHeadersItself('const rateLimitWaitAt = (headers: Headers) => null')).toEqual(['declares rateLimitWaitAt'])
    expect(readsRateLimitHeadersItself('function localWait(h: Headers) { return h.get(RETRY_AFTER_HEADER) }')).toEqual(['reads RETRY_AFTER_HEADER'])
    expect(readsRateLimitHeadersItself('for (const name of RATE_LIMIT_RESET_HEADERS) h.get(name)')).toEqual(['walks the reset headers'])
    // Asking whether a 503 carries Retry-After is not reading it.
    expect(readsRateLimitHeadersItself('response.headers.has(RETRY_AFTER_HEADER)')).toEqual([])
    // Prose about the header, in a comment or a message, is no reading of it.
    expect(readsRateLimitHeadersItself('// reads retry-after\nconst m = `answered 503 with Retry-After, which proves nothing`')).toEqual([])
    expect(callsSharedReader("import { rateLimitRetryAt } from '../rate-limit-headers'\nconst at = rateLimitRetryAt(headers, now, note)")).toBe(true)
    expect(callsSharedReader("import type { RateLimitHeader } from '../rate-limit-headers'\nconst at = rateLimitRetryAt(headers, now, note)")).toBe(false)
    expect(callsSharedReader("import { rateLimitRetryAt } from '../rate-limit-headers'\nconst at = null")).toBe(false)
  })
})
