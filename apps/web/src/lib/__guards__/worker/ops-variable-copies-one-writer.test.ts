/**
 * The last good copy of each ops version's plain variables has one writer
 * (#2999, phase 3 of #2982).
 *
 * ops_variable_copies is what a claimed run falls back on while the bidding
 * Worker cannot be reached, so what it holds must be exactly what the bidding
 * Worker last served for a version, written by the minute tick
 * (ops/variable-copies.ts writeVariableCopies) from the tick's own successful
 * opsRunVariables answers. A second writer (a step test, the run itself, an
 * entrypoint) could write values bidding never served for that version, or a
 * partial list that a fallback would read as bidding saying a name is absent.
 *
 * So the write (save_variable_copies, through ops-writes.ts's
 * saveVariableCopies) may be named, outside comments, only where listed below
 * with its reason. The behaviour is proven in ops/__tests__/tick.test.ts; this
 * keeps a later change from adding a writer that test does not drive.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WORKER_SRC, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

const ALLOWED: Readonly<Record<string, string>> = {
  'apps/worker/src/ops/ops-writes.ts': 'the typed wrapper of save_variable_copies, the one .rpc( of it',
  'apps/worker/src/ops/ops-rpcs.ts': 'classifies save_variable_copies as a lane wide write',
  'apps/worker/src/ops/variable-copies.ts': 'the one writer: saves what the tick\'s own opsRunVariables answers served',
  'apps/worker/src/ops/tick-live.ts': 'connects the minute tick\'s write to the ops database',
}

/** Whether a source names the copy writer outside its comments. */
export function namesVariableCopyWriter(source: string): boolean {
  const code = sanitizeSource(source, { blankStrings: false })
  return /\bsaveVariableCopies\b|save_variable_copies/.test(code)
}

const rel = (full: string) => path.relative(REPO_ROOT, full).replace(/\\/g, '/')
const files = listTsFiles(WORKER_SRC).map((full) => ({ rel: rel(full), source: readFileSync(full, 'utf8') }))

describe('the variable copy has one writer, the minute tick (#2999)', () => {
  it('scans the Worker\'s source, the run, the step test and the entrypoints included (L98)', () => {
    expect(files.length).toBeGreaterThan(100)
    for (const f of ['apps/worker/src/ops/run-live.ts', 'apps/worker/src/ops/step-test.ts', 'apps/worker/src/ops/ops-connections-entrypoint.ts', 'apps/worker/src/ops/tick.ts']) {
      expect(files.some((x) => x.rel === f), f).toBe(true)
    }
  })

  it('no module but the listed ones names the copy writer', () => {
    expect(files.filter((f) => !Object.hasOwn(ALLOWED, f.rel) && namesVariableCopyWriter(f.source)).map((f) => f.rel)).toEqual([])
  })

  it('every listed module exists, names it, and says why it may', () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      const full = path.join(REPO_ROOT, file)
      expect(existsSync(full), `${file} is listed and does not exist`).toBe(true)
      expect(namesVariableCopyWriter(readFileSync(full, 'utf8')), `${file} is listed and no longer names the copy writer`).toBe(true)
      expect(reason.length).toBeGreaterThan(20)
    }
  })

  it('sees a planted writer, and not one named in a comment (seen red)', () => {
    expect(namesVariableCopyWriter('await db.saveVariableCopies([copy])')).toBe(true)
    expect(namesVariableCopyWriter('await callOpsRpc(client, \'save_variable_copies\', {})')).toBe(true)
    expect(namesVariableCopyWriter('// never saveVariableCopies here\nconst x = 1')).toBe(false)
  })
})
