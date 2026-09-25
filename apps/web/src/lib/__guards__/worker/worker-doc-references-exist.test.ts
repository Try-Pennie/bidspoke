/**
 * Every docs file the worker names exists (#1454).
 *
 * Alert remedies and scripts send a person to a runbook by path, at the moment
 * something is already wrong. A renamed or deleted doc leaves that pointer
 * aimed at nothing, and nothing notices until somebody follows it mid incident.
 *
 * It reads worker source, so it lives here rather than in the worker's own
 * tests, which `worker-guards-placement.test.ts` enforces.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, WORKER_SRC, listFiles } from '../../__tests__/_scan-utils'

const SCANNED = [WORKER_SRC, path.join(REPO_ROOT, 'apps/worker/scripts')]
const DOC_PATH = /\bdocs\/[A-Za-z0-9_./-]+?\.(?:md|sql)\b/g

function references(): Array<{ file: string; doc: string }> {
  const found: Array<{ file: string; doc: string }> = []
  for (const dir of SCANNED) {
    for (const file of listFiles(dir, { exts: ['.ts'] })) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(DOC_PATH)) found.push({ file: path.relative(REPO_ROOT, file), doc: m[0] })
    }
  }
  return found
}

describe('docs the worker points people at', () => {
  it('finds references at all, so an empty scan cannot read as every one resolving', () => {
    const docs = references().map((r) => r.doc)
    expect(docs.length).toBeGreaterThan(5)
    // The runbook the archive's failed send alert names.
    expect(docs).toContain('docs/snowflake-slow-write.md')
  })

  it('names only files that exist', () => {
    const dead = references().filter((r) => !existsSync(path.join(REPO_ROOT, r.doc)))
    expect(dead).toEqual([])
  })
})
