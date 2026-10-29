/**
 * One SQL suite run at a time per container (#3012).
 *
 * Each project's suite runs in ONE Docker container on the Mac, shared by every
 * worktree and session. Two runs at once replayed into and tested one database
 * together and failed each other with errors naming a test rather than the other
 * run (2026-10-29: run_engine_concurrency, then ops_tick). So
 * `scripts/sql-suite/run.sh` holds a lock (`scripts/sql-suite/lock.sh`) for its
 * whole run; a second run waits a bounded time, then refuses naming the holder;
 * a lock left by a killed run is taken over; and the lock goes when the run ends,
 * however it ends.
 *
 * These tests drive the real scripts with a stub `docker` first on PATH, never
 * Docker itself, and a lock folder of their own, never the machine's. The stub
 * records each call and, for a run told to, holds `docker info` until a release
 * file appears: that is a run holding the lock in the middle of its work. Every
 * other `docker info` fails, so a run that got past the lock ends at once with
 * start-db.sh's "Docker daemon is not running", which is the failure path whose
 * release the tests check.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { REPO_ROOT } from './_scan-utils'

const SUITE = path.join(REPO_ROOT, 'scripts/sql-suite')
const RUN = path.join(SUITE, 'run.sh')

const STUB_DOCKER = `#!/bin/sh
if [ "$1" = info ]; then
  if [ -e "$STUB_LOCK_HOLDER" ]; then held=held; else held=free; fi
  echo "info lock=$held" >> "$STUB_DOCKER_LOG"
  if [ -n "$STUB_DOCKER_BLOCK_UNTIL" ]; then
    # Also stops once the fixture folder is gone, so a test that failed
    # part way never leaves a stub waiting for ever on a file nobody can write.
    while [ ! -e "$STUB_DOCKER_BLOCK_UNTIL" ] && [ -d "$(dirname "$STUB_DOCKER_BLOCK_UNTIL")" ]; do sleep 0.02; done
  fi
  exit 1
fi
echo "$*" >> "$STUB_DOCKER_LOG"
exit 1
`

type Fixture = { root: string; bin: string; locks: string; container: string; lock: string; holder: string }

const dirs: string[] = []
const children: ChildProcess[] = []
const releases: string[] = []

afterEach(async () => {
  // A run a failed test left going is killed and waited for; removing the
  // fixtures then ends any stub under it, which stops once its folder is gone.
  for (const r of releases.splice(0)) if (existsSync(path.dirname(r))) writeFileSync(r, '')
  await Promise.all(children.splice(0).map((c) => new Promise<void>((resolve) => {
    if (c.exitCode !== null || c.signalCode !== null) return resolve()
    c.on('exit', () => resolve())
    c.kill('SIGKILL')
  })))
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

let n = 0
function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'sql-suite-lock-'))
  dirs.push(root)
  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(path.join(bin, 'docker'), STUB_DOCKER, { mode: 0o755 })
  const locks = path.join(root, 'locks')
  const container = `sql-suite-lock-test-${process.pid}-${n++}`
  const lock = path.join(locks, `${container}.lock`)
  return { root, bin, locks, container, lock, holder: path.join(lock, 'holder') }
}

function env(f: Fixture, log: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${f.bin}:${process.env.PATH}`,
    SQL_SUITE_CONTAINER: f.container,
    SQL_SUITE_LOCK_DIR: f.locks,
    SQL_SUITE_LOCK_POLL: '0.05',
    SQL_SUITE_LOCK_WAIT: '0',
    STUB_DOCKER_LOG: path.join(f.root, log),
    STUB_LOCK_HOLDER: f.holder,
    ...extra,
  }
  delete e.SQL_SUITE_LOCK_HELD
  delete e.SQL_SUITE_PROJECT
  return e
}

function logOf(f: Fixture, log: string): string {
  const p = path.join(f.root, log)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

async function waitFor(what: string, cond: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

type Running = { child: ChildProcess; stderr: () => string; done: Promise<{ code: number | null; signal: string | null }> }

function start(script: string, e: NodeJS.ProcessEnv, args: string[] = []): Running {
  const child = spawn('bash', [script, ...args], { env: e, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let err = ''
  child.stderr!.on('data', (d) => (err += String(d)))
  child.stdout!.on('data', () => {})
  const done = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.on('close', (code, signal) => resolve({ code, signal })),
  )
  return { child, stderr: () => err, done }
}

/** A run.sh that takes the lock and then holds it inside `docker info` until released. */
async function holdLock(f: Fixture): Promise<{ run: Running; release: () => void }> {
  const releaseFile = path.join(f.root, 'release-holder')
  releases.push(releaseFile)
  const run = start(RUN, env(f, 'holder.log', { STUB_DOCKER_BLOCK_UNTIL: releaseFile }))
  // Reaching docker info means run.sh took the lock AND start-db.sh, which run.sh
  // starts, shared it rather than waiting on its own parent.
  await waitFor('the holder to reach docker info', () => logOf(f, 'holder.log').includes('info'))
  return { run, release: () => writeFileSync(releaseFile, '') }
}

function holderPid(f: Fixture): string {
  return /^pid=(\d+)$/m.exec(readFileSync(f.holder, 'utf8'))![1]
}

describe('scripts/sql-suite lock (#3012)', () => {
  it('refuses a second run while the first holds the lock, naming the holder, and touches no container', async () => {
    const f = fixture()
    const { run, release } = await holdLock(f)
    expect(logOf(f, 'holder.log')).toContain('info lock=held')
    expect(holderPid(f)).toBe(String(run.child.pid))

    const second = spawnSync('bash', [RUN], { env: env(f, 'second.log'), encoding: 'utf8' })
    expect(second.status, second.stderr).toBe(2)
    expect(second.stderr).toContain(`container ${f.container} is in use by another SQL suite run`)
    expect(second.stderr).toContain(`pid ${run.child.pid}, started `)
    expect(second.stderr).toMatch(/started \d{4}-\d\d-\d\d \d\d:\d\d:\d\d ET, in /)
    expect(second.stderr).toContain(`in ${REPO_ROOT}`)
    expect(second.stderr).toContain(`rm -rf ${f.lock}`)
    expect(logOf(f, 'second.log')).toBe('')

    release()
    const end = await run.done
    expect(end.code).toBe(2)
    expect(existsSync(f.lock)).toBe(false)
  }, 30_000)

  it('makes a second run wait, saying so, and run once the first releases', async () => {
    const f = fixture()
    const { run, release } = await holdLock(f)
    const second = start(RUN, env(f, 'second.log', { SQL_SUITE_LOCK_WAIT: '60' }))
    await waitFor('the second run to say it is waiting', () => second.stderr().includes('waiting for the SQL suite run'))
    expect(second.stderr()).toContain(`pid ${run.child.pid}`)
    expect(logOf(f, 'second.log')).toBe('')

    release()
    expect((await run.done).code).toBe(2)
    const end = await second.done
    expect(end.code, second.stderr()).toBe(2)
    expect(logOf(f, 'second.log')).toContain('info lock=held')
    expect(existsSync(f.lock)).toBe(false)
  }, 30_000)

  it('holds the lock during a run and releases it when the run fails', () => {
    const f = fixture()
    const r = spawnSync('bash', [RUN], { env: env(f, 'run.log'), encoding: 'utf8' })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('the Docker daemon is not running')
    expect(logOf(f, 'run.log')).toContain('info lock=held')
    expect(existsSync(f.lock)).toBe(false)
  })

  it('releases the lock when the run is stopped with SIGTERM', async () => {
    const f = fixture()
    const { run, release } = await holdLock(f)
    run.child.kill('SIGTERM')
    // bash runs the trap once its foreground child returns.
    release()
    const end = await run.done
    expect(end.code).toBe(143)
    expect(existsSync(f.lock)).toBe(false)
  }, 30_000)

  it('takes over a lock left by a run killed with SIGKILL', async () => {
    const f = fixture()
    const { run, release } = await holdLock(f)
    const pid = holderPid(f)
    run.child.kill('SIGKILL')
    // The orphaned start-db.sh and stub keep the pipes open (L235) until freed.
    release()
    await run.done
    expect(existsSync(f.holder)).toBe(true)

    const r = spawnSync('bash', [RUN], { env: env(f, 'second.log', { SQL_SUITE_LOCK_WAIT: '10' }), encoding: 'utf8' })
    expect(r.stderr).toContain(`taking over the SQL suite lock for ${f.container}: its holder, pid ${pid}, is no longer running`)
    expect(r.status, r.stderr).toBe(2)
    expect(logOf(f, 'second.log')).toContain('info lock=held')
    expect(existsSync(f.lock)).toBe(false)
  }, 30_000)

  it('takes over a lock whose pid is now a different process', () => {
    const f = fixture()
    mkdirSync(f.lock, { recursive: true })
    // This test's own process is alive, but did not start at the recorded time.
    writeFileSync(f.holder, `pid=${process.pid}\npid_start=Thu Jan  1 00:00:00 1970\nstarted=1970-01-01 00:00:00 ET\nworktree=/nowhere\n`)
    const r = spawnSync('bash', [RUN], { env: env(f, 'run.log', { SQL_SUITE_LOCK_WAIT: '10' }), encoding: 'utf8' })
    expect(r.stderr).toContain(`pid ${process.pid} is now a different process`)
    expect(r.status, r.stderr).toBe(2)
    expect(logOf(f, 'run.log')).toContain('info lock=held')
    expect(existsSync(f.lock)).toBe(false)
  })

  it('waits on a fresh lock with no holder recorded yet, and takes over an old one', () => {
    const f = fixture()
    mkdirSync(f.lock, { recursive: true })
    const fresh = spawnSync('bash', [RUN], { env: env(f, 'fresh.log'), encoding: 'utf8' })
    expect(fresh.status).toBe(2)
    expect(fresh.stderr).toContain('holder: a run that has not yet recorded itself')
    expect(logOf(f, 'fresh.log')).toBe('')
    expect(existsSync(f.lock)).toBe(true)

    const old = (Date.now() - 120_000) / 1000
    utimesSync(f.lock, old, old)
    const r = spawnSync('bash', [RUN], { env: env(f, 'old.log', { SQL_SUITE_LOCK_WAIT: '10' }), encoding: 'utf8' })
    expect(r.stderr).toMatch(/it records no holder and is \d+s old/)
    expect(r.status, r.stderr).toBe(2)
    expect(logOf(f, 'old.log')).toContain('info lock=held')
    expect(existsSync(f.lock)).toBe(false)
  })

  // Run by hand, a `start-db.sh --reset` would remove the container under a
  // running suite, and replay.sh would write into it.
  it.each(['start-db.sh', 'replay.sh'])('makes %s run by hand wait for the lock too', async (script) => {
    const f = fixture()
    const { run, release } = await holdLock(f)
    const r = spawnSync('bash', [path.join(SUITE, script), '--reset'], { env: env(f, 'byhand.log'), encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(2)
    expect(r.stderr).toContain(`pid ${run.child.pid}`)
    expect(logOf(f, 'byhand.log')).toBe('')
    release()
    await run.done
    expect(existsSync(f.lock)).toBe(false)
  }, 30_000)
})
