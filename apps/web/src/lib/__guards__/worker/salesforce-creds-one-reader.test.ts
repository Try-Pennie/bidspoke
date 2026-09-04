/**
 * Guard: nothing reads the Salesforce credentials off the Worker env directly.
 *
 * Measured on prod 2026-09-04: SALESFORCE_INSTANCE_URL and SALESFORCE_CLIENT_ID
 * exist ONLY in the environment_variables table, while SALESFORCE_CLIENT_SECRET
 * is in that table AND as a Cloudflare secret. So a reader that consults the
 * Worker env alone sees one value of three and throws before any query runs.
 *
 * That defect shipped three times: the hourly bid matrix sync had been failing
 * every hour since 2026-08-22 (#982), the matrix audit the same way, and a brand
 * new job inherited it within the hour on 2026-09-04 (#1171, fixed in #1172)
 * because it copied a scheduled reader rather than the working engine path.
 *
 * The failure is invisible to any check done by hand, because the interactive
 * path reads the merged env and works. So the guard is the source, not a test
 * run: resolution belongs to lib/salesforce-creds.ts and nowhere else (#1174).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC, listTsFiles } from '../../__tests__/_scan-utils'

// Two allowed readers, each for a stated reason rather than because it was there
// when the guard was written.
//
// lib/salesforce-creds.ts is the resolution itself.
//
// engine/nodes/salesforce.ts reads `enrichedCtx.env`, which is the MERGED env the
// executor builds (ctx.env, already carrying the org store, plus the Worker
// bindings). That is the correct source and the reason the engine's Salesforce
// steps work while every raw-Worker-env reader failed. It is exempt because of
// what it reads FROM, not because of where it lives, so a new read of the raw
// Worker env in that file would still be wrong.
const ALLOWED = ['lib/salesforce-creds.ts', 'engine/nodes/salesforce.ts']

const KEYS = ['SALESFORCE_INSTANCE_URL', 'SALESFORCE_CLIENT_ID', 'SALESFORCE_CLIENT_SECRET']

function offenders(): Array<{ file: string; line: number; key: string }> {
  const found: Array<{ file: string; line: number; key: string }> = []
  for (const dir of ['lib', 'engine', 'routes'].map((d) => path.join(WORKER_SRC, d))) {
    for (const file of listTsFiles(dir)) {
      const rel = path.relative(WORKER_SRC, file).replace(/\\/g, '/')
      if (rel.includes('__tests__')) continue
      if (ALLOWED.includes(rel)) continue
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((text, i) => {
        // Only a read off an env-shaped object counts. A comment, an error
        // message naming what is missing, or a doc reference is fine.
        if (text.trimStart().startsWith('//') || text.trimStart().startsWith('*')) return
        for (const key of KEYS) {
          if (new RegExp(`(?:rawEnv|env|cfEnv|process\\.env)(?:\\s*as[^.]*)?\\.\\s*${key}\\b`).test(text)
            || new RegExp(`\\[['"\`]${key}['"\`]\\]`).test(text)) {
            found.push({ file: rel, line: i + 1, key })
          }
        }
      })
    }
  }
  return found
}

describe('Salesforce credentials are resolved in one place (#1174)', () => {
  it('is read off the Worker env only by lib/salesforce-creds.ts', () => {
    expect(offenders()).toEqual([])
  })

  it('can actually see such a read, so a green result means something', () => {
    // A source scan that matches nothing is indistinguishable from one whose
    // pattern is broken, and this codebase has shipped exactly that (a guard
    // that passed vacuously because the construct it looked for never occurs).
    const sample = '  const instanceUrl = (rawEnv.SALESFORCE_INSTANCE_URL ?? "").replace(/\\/$/, "")'
    const pattern = new RegExp(`(?:rawEnv|env|cfEnv|process\\.env)(?:\\s*as[^.]*)?\\.\\s*SALESFORCE_INSTANCE_URL\\b`)
    expect(pattern.test(sample)).toBe(true)
  })
})
