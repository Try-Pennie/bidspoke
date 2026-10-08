import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ABSENT_AT_LIVE } from '../expected-changes'

/**
 * .github/scripts/money-gate-live-expected.sh (#1921): what the money gate hands
 * the verdict as the live worker's expected-changes.json (#1836). Each outcome is
 * proved by running the script, in a throwaway repository, with curl stood in.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
const script = join(repoRoot, '.github', 'scripts', 'money-gate-live-expected.sh')
const EXPECTED_PATH = 'apps/worker/money-gate/expected-changes.json'
const CONTENT = '{"entries":[{"workflow":"W","check":"route","field":"route","reason":"shipped"}]}\n'

// Set, not inherited: a machine may have no git identity, and signing must not prompt (L435).
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'gate', GIT_AUTHOR_EMAIL: 'gate@example.invalid', GIT_COMMITTER_NAME: 'gate', GIT_COMMITTER_EMAIL: 'gate@example.invalid' }
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: gitEnv })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

let repo: string
let withFile: string
let withoutFile: string
/** Every directory these tests make, removed when they finish. */
const made: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

beforeAll(() => {
  repo = tempDir('mg-live-')
  git(repo, 'init', '-q')
  mkdirSync(join(repo, dirname(EXPECTED_PATH)), { recursive: true })
  writeFileSync(join(repo, EXPECTED_PATH), CONTENT)
  git(repo, 'add', EXPECTED_PATH)
  git(repo, 'commit', '-q', '-m', 'with the file')
  withFile = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'rm', '-q', EXPECTED_PATH)
  git(repo, 'commit', '-q', '-m', 'without the file')
  withoutFile = git(repo, 'rev-parse', 'HEAD')
})

/** Runs the script in the throwaway repository; `url` undefined leaves the address unset. */
function run(url: string | undefined, curl: { body?: string; code?: number } = {}, extraEnv: Record<string, string> = {}): { expectedLive: string; commit: string; status: number | null; work: string; curled: boolean } {
  const dir = tempDir('mg-live-run-')
  const stub = join(dir, 'curl')
  const called = join(dir, 'called')
  writeFileSync(stub, `#!/usr/bin/env bash\necho "$@" > ${JSON.stringify(called)}\nprintf '%s' ${JSON.stringify(curl.body ?? '')}\nexit ${curl.code ?? 0}\n`)
  chmodSync(stub, 0o755)
  const work = join(dir, 'work')
  mkdirSync(work)
  const env: Record<string, string | undefined> = { ...gitEnv, CURL_BIN: stub, ...extraEnv }
  delete env.MONEY_GATE_LIVE_WORKER_URL
  if (url !== undefined) env.MONEY_GATE_LIVE_WORKER_URL = url
  const r = spawnSync('bash', [script, work], { cwd: repo, encoding: 'utf8', env })
  const [expectedLive = '', commit = ''] = r.stdout.split('\n')
  return { expectedLive, commit, status: r.status, work, curled: existsSync(called) }
}

describe('money-gate-live-expected.sh (#1921)', () => {
  it('asks nothing when no address is set, as on a Deploy', () => {
    const r = run(undefined)
    expect(r).toMatchObject({ expectedLive: '', commit: '', status: 0, curled: false })
  })

  it('says so when the address is set but empty, rather than skipping silently', () => {
    const r = run('')
    expect(r.status).toBe(0)
    expect(r.expectedLive).toBe('unreadable:MONEY_GATE_LIVE_WORKER_URL is empty, so the live worker could not be asked')
    expect(r.curled).toBe(false)
  })

  it('names each way the worker answer can fail, and never blames the worker for the runner', () => {
    expect(run('https://worker.example', { body: '{"version":"unknown"}' }).expectedLive).toBe("unreadable:the live worker reported no commit (got 'unknown')")
    expect(run('https://worker.example', { code: 22 }).expectedLive).toBe('unreadable:the live worker at https://worker.example could not be reached')
    expect(run('https://worker.example', { body: '<html>' }).expectedLive).toBe("unreadable:the live worker's answer is not JSON")
    expect(run('https://worker.example', { body: '{"version":"x"}' }, { JQ_BIN: 'no-such-jq-here' }).expectedLive).toBe("unreadable:jq is not installed on this runner, so the live worker's answer could not be read")
  })

  it('hands over the live commit and a copy of its file', () => {
    const r = run('https://worker.example', { body: JSON.stringify({ version: withFile }) })
    expect(r.status).toBe(0)
    expect(r.commit).toBe(withFile)
    expect(r.expectedLive).toBe(join(r.work, 'expected-live.json'))
    expect(readFileSync(r.expectedLive, 'utf8')).toBe(CONTENT)
  })

  it('marks the file absent at a live commit without it', () => {
    const r = run('https://worker.example', { body: JSON.stringify({ version: withoutFile }) })
    expect(r).toMatchObject({ expectedLive: ABSENT_AT_LIVE, commit: withoutFile, status: 0 })
  })

  it('is unreadable, never absent, when the live commit cannot be found', () => {
    const unknown = 'c'.repeat(40)
    const r = run('https://worker.example', { body: JSON.stringify({ version: unknown }) })
    expect(r.status).toBe(0)
    expect(r.expectedLive).toBe(`unreadable:the live worker's commit ${unknown} could not be fetched`)
  })
})
