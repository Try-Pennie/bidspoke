import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * Serving the built site for the browser checks on a port nobody else holds (#2768).
 *
 * The accessibility and auth gate jobs both served on port 3000. On GitHub each
 * job has a machine to itself; on the Mac runners they share one machine with
 * each other, with Slate's jobs and with Dan's own dev server. Two jobs at once
 * then collide, and worse, a job whose server failed to start finds somebody
 * else's answering on 3000 and runs its checks against that.
 *
 * So the script picks a free port, says it in BASE_URL, and counts the server up
 * only while the process it started is still alive.
 */
const script = path.join(REPO_ROOT, '.github/scripts/serve-pages-artifact.sh')

type Kind = 'serve' | 'exit' | 'mute' | 'busy-once' | 'busy-always'

/**
 * A stand in for wrangler: `serve` answers /login on the --port it is given,
 * `exit` dies at once, `mute` never answers; `busy-once` reports the address
 * in use on its first start and serves on the next, and `busy-always` reports
 * it every time, as wrangler does when its port was taken after it was picked.
 */
function fakeWrangler(kind: Kind): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-wrangler-'))
  const file = path.join(dir, 'wrangler')
  const serve = `const p = Number(process.argv[process.argv.indexOf('--port') + 1]); require('http').createServer((q, r) => { r.statusCode = q.url === '/login' ? 200 : 404; r.end() }).listen(p); setTimeout(() => process.exit(0), 20000)`
  const busy = `console.error('[ERROR] Address already in use. Please check that you are not already running a server on this address'); process.exit(1)`
  const starts = path.join(dir, 'starts')
  const body = {
    serve,
    exit: `console.error('fake wrangler: refused to start'); process.exit(1)`,
    mute: `setTimeout(() => process.exit(0), 20000)`,
    'busy-once': `const fs = require('fs'); const n = fs.existsSync(${JSON.stringify(starts)}) ? 1 : 0; fs.writeFileSync(${JSON.stringify(starts)}, 'x'); if (n === 0) { ${busy} } else { ${serve} }`,
    'busy-always': busy,
  }[kind]
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

function run(kind: Kind) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'serve-pages-'))
  const env = path.join(tmp, 'github_env')
  writeFileSync(env, '')
  const res = spawnSync('bash', [script, path.join(tmp, 'pages.log')], {
    encoding: 'utf8',
    cwd: tmp,
    env: { ...process.env, WRANGLER: fakeWrangler(kind), GITHUB_ENV: env, SERVE_WAIT_SECONDS: '3' },
    timeout: 15000,
  })
  return { status: res.status, out: `${res.stdout}${res.stderr}`, githubEnv: readFileSync(env, 'utf8') }
}

describe('serve-pages-artifact.sh', () => {
  it('serves on a free port and hands it to the later steps as BASE_URL', () => {
    const r = run('serve')
    expect(r.status, r.out).toBe(0)
    const port = Number(/^BASE_URL=http:\/\/localhost:(\d+)$/m.exec(r.githubEnv)?.[1])
    expect(port).toBeGreaterThan(0)
    expect(port).not.toBe(3000)
  })

  it('fails at once when the server it started dies, rather than waiting on whatever else answers', () => {
    const r = run('exit')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/exited before it answered/)
    expect(r.out).toMatch(/refused to start/)
    expect(r.githubEnv).toBe('')
  })

  // The port is picked free and then released, and wrangler opens its own
  // internal ports from the same pool before it binds the one it was given, so
  // now and then that one is gone by then (CI on 2026-10-25, port 36935). A
  // port lost that way is retried on a fresh one; any other failure is not.
  it('tries a fresh port when the one it picked was taken before the server bound it', () => {
    const r = run('busy-once')
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/in use by the time the server started, trying another/)
    expect(r.githubEnv).toMatch(/^BASE_URL=http:\/\/localhost:\d+$/m)
  })

  it('gives up after three ports, each taken, and says so', () => {
    const r = run('busy-always')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/3 ports were each in use/)
    expect(r.githubEnv).toBe('')
  })

  it('fails when the server never answers', () => {
    const r = run('mute')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/did not come up within 3s/)
    expect(r.githubEnv).toBe('')
  })
})
