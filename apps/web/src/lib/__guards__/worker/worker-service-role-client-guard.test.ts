import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { WORKER_SRC, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

/**
 * Every Supabase client the Worker builds must authenticate with
 * `SUPABASE_SECRET_KEY`, which is the `service_role` key.
 *
 * Issue #614. Four separate comments across the docs, the worker source and two
 * migrations attributed a timeout to "the PostgREST 8s authenticator limit". That
 * is the limit for `authenticator` / `authenticated`. The Worker is `service_role`,
 * whose `statement_timeout` is **30s** (verified live 2026-08-14 in
 * `pg_db_role_setting`: anon 3s, authenticated 8s, authenticator 8s, service_role
 * 30s, cluster default 120s). A 57014 from the Worker therefore means a statement
 * ran past thirty seconds, a much louder signal than "we brushed an 8s gateway",
 * and #610 had already sized `PURGE_BATCH` and the retry delays off the wrong
 * number once.
 *
 * The corrected comments all rest on ONE fact: the Worker talks to Postgres as
 * service_role, everywhere. That fact is what this guard holds still. A second
 * client built with the publishable key would run as `anon` (3s) and silently
 * falsify every one of those comments, and nothing else in the suite would notice,
 * because such a client works fine until a query gets slow.
 */
interface ClientCall {
  file: string
  line: number
  key: string
}

/** The key argument of every `createClient(` call in the worker source. */
export function findClientCalls(files: { path: string; src: string }[]): ClientCall[] {
  const out: ClientCall[] = []
  for (const { path: file, src } of files) {
    // Keep string contents so the env key name is still readable, but drop
    // comments so a `createClient` mentioned in prose is not treated as a call.
    const scrubbed = sanitizeSource(src, { blankStrings: false }).replace(
      /(^|[^.\w])createClient\b/g,
      (m) => m,
    )
    const re = /\bcreateClient\s*(?:<[^>]*>)?\s*\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(scrubbed))) {
      const open = m.index + m[0].length - 1
      const args = scrubbed.slice(open, open + 400)
      // Second argument is the key.
      const key = /,\s*([\w.]*SUPABASE[\w]*|[\w.]+)/.exec(args)?.[1] ?? '(unreadable)'
      out.push({ file, line: scrubbed.slice(0, m.index).split('\n').length, key })
    }
  }
  return out
}

const workerFiles = listTsFiles(WORKER_SRC).map((path) => ({ path, src: readFileSync(path, 'utf8') }))

describe('worker Supabase clients are service_role (#614)', () => {
  it('builds every client with SUPABASE_SECRET_KEY', () => {
    const wrong = findClientCalls(workerFiles).filter((c) => !c.key.includes('SUPABASE_SECRET_KEY'))
    const described = wrong.map((c) => `${c.file.replace(/.*apps\//, 'apps/')}:${c.line} uses ${c.key}`)
    expect(described, 'a non-service_role client changes the statement_timeout the docs cite').toEqual([])
  })

  it('found a client call at all, so it cannot pass vacuously', () => {
    // Without this the guard is green on a renamed factory, having scanned for a
    // call that no longer exists.
    expect(findClientCalls(workerFiles).length).toBeGreaterThan(0)
  })

  it('flags a client built with the publishable key', () => {
    const files = [{ path: 'x.ts', src: 'const c = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {})' }]
    const wrong = findClientCalls(files).filter((c) => !c.key.includes('SUPABASE_SECRET_KEY'))
    expect(wrong).toHaveLength(1)
    expect(wrong[0].key).toBe('env.SUPABASE_PUBLISHABLE_KEY')
  })

  it('accepts the real factory shape, generic parameter and all', () => {
    const files = [{ path: 'x.ts', src: 'const client = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {\n  auth: {},\n})' }]
    expect(findClientCalls(files).filter((c) => !c.key.includes('SUPABASE_SECRET_KEY'))).toEqual([])
  })

  it('ignores createClient written inside a comment', () => {
    const files = [{ path: 'x.ts', src: '// we could createClient(url, env.SUPABASE_PUBLISHABLE_KEY) here\nconst x = 1' }]
    expect(findClientCalls(files)).toEqual([])
  })
})
