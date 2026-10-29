/**
 * The command line, run as a real process (#1695): `node src/main.ts`, the file
 * `pnpm run convert` runs, against a local stand-in for the Data API. It must
 * print the draft and write nothing: no request but a read, no file in the
 * export, no file where it runs.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { StoredRow } from '@bidspoke/porting-evidence/inventory'
import { EXPORT_DIR, fileSha, recordedRow } from './fixture.ts'

const MAIN = path.resolve(import.meta.dirname, '..', 'main.ts')

interface Seen { method: string; url: string }
let server: Server
let seen: Seen[] = []
let answer: StoredRow[] = []
let base = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '' })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(answer))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const dirs: string[] = []
afterEach(() => {
  seen = []
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Every file under a directory with its size and modified time, to compare before and after. */
function listing(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      const full = path.join(d, e)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else out.push(`${path.relative(dir, full)} ${st.size} ${st.mtimeMs}`)
    }
  }
  walk(dir)
  return out
}

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string; cwd: string }> {
  const cwd = mkdtempSync(path.join(tmpdir(), 'convert-cwd-'))
  dirs.push(cwd)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      cwd,
      env: { PATH: process.env.PATH, SUPABASE_URL: base, SUPABASE_SECRET_KEY: 'test-key' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString() })
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr, cwd }))
  })
}

describe('pnpm run convert (#1695)', () => {
  it('prints the draft, reads the inventory once with GET, and writes nothing', async () => {
    answer = [recordedRow('p_Fx1Lead')]
    const before = listing(EXPORT_DIR)
    // pnpm passes the separator through, so the command line must accept it.
    const { code, stdout, stderr, cwd } = await run(['--', EXPORT_DIR, 'p_Fx1Lead'])
    expect(stderr).toMatch(/Nothing written/)
    expect(code).toBe(0)
    const draft = JSON.parse(stdout) as { workflow: { hashid: string }; snapshot: { sha256: string }; steps: unknown[] }
    expect(draft.workflow.hashid).toBe('p_Fx1Lead')
    expect(draft.snapshot.sha256).toBe(fileSha('p_Fx1Lead'))
    expect(draft.steps).toHaveLength(8)
    expect(seen).toHaveLength(1)
    expect(seen[0].method).toBe('GET')
    expect(seen[0].url).toContain('pipedream_hashid=eq.p_Fx1Lead')
    expect(listing(EXPORT_DIR)).toEqual(before)
    expect(readdirSync(cwd)).toEqual([])
  })

  it('refuses an older snapshot by name on stderr, prints no draft, and exits 1', async () => {
    answer = [recordedRow('p_Fx1Lead', { last_seen_export_at: '2026-10-20T12:00:00Z' })]
    const { code, stdout, stderr } = await run([EXPORT_DIR, 'p_Fx1Lead'])
    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/snapshot_older_than_recorded/)
    expect(seen.every((s) => s.method === 'GET')).toBe(true)
  })

  it('prints its usage and exits 2 without a workflow id', async () => {
    const { code, stderr } = await run([EXPORT_DIR])
    expect(code).toBe(2)
    expect(stderr).toMatch(/usage: .*<export dir> <workflow id>/)
    expect(seen).toEqual([])
  })
})
