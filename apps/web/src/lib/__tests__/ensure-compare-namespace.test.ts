import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REPO_ROOT, readWorkflow, workflowJobBody } from './_scan-utils'

/**
 * Deploy Worker makes sure the compare dispatch namespace exists, and its
 * outbound Worker, before the engine that binds them deploys (#1708 part B).
 *
 * wrangler refuses to deploy a Worker bound to a namespace that does not exist,
 * and a namespace whose outbound Worker is missing would have nowhere to send
 * shadow runs' requests, so both are checked first, and the namespace is created
 * when missing. That makes a deploy into a fresh account provision it, and keeps
 * the one-time creation in git rather than in somebody's dashboard (L31, L570).
 *
 * The Cloudflare API is a seam (CF_API) set in every test: a fake that answers
 * from a per call plan and records every call, so no test reaches the network.
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/ensure-compare-namespace.sh')
const ACCOUNT = 'acct'
const NAMESPACE = 'bidspoke-code-nodes-compare'
const OUTBOUND = 'bidspoke-compare-outbound'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ensure-ns-'))
  // Answers `<METHOD> <PATH> [body]` from the file named for that call, and logs it.
  writeFileSync(
    path.join(dir, 'fake-cf.sh'),
    [
      '#!/usr/bin/env bash',
      'echo "$1 $2 ${3-}" >> "$FAKE_DIR/calls"',
      'key=$(printf "%s %s" "$1" "$2" | tr "/ " "__")',
      'if [ -f "$FAKE_DIR/answer-$key" ]; then cat "$FAKE_DIR/answer-$key"; else echo \'{"success":false,"errors":[{"message":"no fake answer"}]}\'; fi',
    ].join('\n'),
  )
  chmodSync(path.join(dir, 'fake-cf.sh'), 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const answer = (method: string, apiPath: string, body: unknown) =>
  writeFileSync(path.join(dir, `answer-${`${method} ${apiPath}`.replace(/[/ ]/g, '_')}`), JSON.stringify(body))

const outboundExists = () => answer('GET', `/workers/scripts/${OUTBOUND}/settings`, { success: true, result: { bindings: [] } })
const namespaces = (...names: string[]) => answer('GET', '/workers/dispatch/namespaces', { success: true, result: names.map((n) => ({ namespace_name: n })) })

function run(args: string[] = [ACCOUNT, NAMESPACE, OUTBOUND]) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    // A deliberately minimal environment, so no real CLOUDFLARE_API_TOKEN or CF_API leaks in (L439).
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', CF_API: path.join(dir, 'fake-cf.sh'), FAKE_DIR: dir } as NodeJS.ProcessEnv,
  })
  const calls = existsSync(path.join(dir, 'calls')) ? readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n') : []
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls }
}

describe('ensure-compare-namespace', () => {
  it('does nothing when the namespace and its outbound Worker both exist', () => {
    outboundExists()
    namespaces('bidspoke-code-nodes', NAMESPACE)
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`${NAMESPACE} exists`)
    expect(r.calls.some((c) => c.startsWith('POST'))).toBe(false)
  })

  it('creates the namespace when it is missing', () => {
    outboundExists()
    namespaces('bidspoke-code-nodes')
    answer('POST', '/workers/dispatch/namespaces', { success: true, result: { namespace_name: NAMESPACE } })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`created ${NAMESPACE}`)
    expect(r.calls).toContain(`POST /workers/dispatch/namespaces {"name":"${NAMESPACE}"}`)
  })

  it('refuses by name, creating nothing, when the outbound Worker does not exist', () => {
    answer('GET', `/workers/scripts/${OUTBOUND}/settings`, { success: false, errors: [{ message: 'workers.api.error.script_not_found' }] })
    namespaces('bidspoke-code-nodes')
    const r = run()
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/::error::/)
    expect(r.stderr).toContain(OUTBOUND)
    expect(r.calls.some((c) => c.startsWith('POST'))).toBe(false)
  })

  it('refuses by name when the namespaces cannot be listed, rather than creating one blind', () => {
    outboundExists()
    answer('GET', '/workers/dispatch/namespaces', { success: false, errors: [{ message: 'Authentication error' }] })
    const r = run()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Authentication error')
    expect(r.calls.some((c) => c.startsWith('POST'))).toBe(false)
  })

  it('refuses with Cloudflare\'s reason when the namespace cannot be created', () => {
    outboundExists()
    namespaces()
    answer('POST', '/workers/dispatch/namespaces', { success: false, errors: [{ message: 'namespace limit reached' }] })
    const r = run()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('namespace limit reached')
  })

  it('refuses by name, asking Cloudflare nothing, when the API token is unset and no fake stands in', () => {
    const r = spawnSync('bash', [SCRIPT, ACCOUNT, NAMESPACE, OUTBOUND], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' } as NodeJS.ProcessEnv })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('CLOUDFLARE_API_TOKEN is unset')
    expect(r.stderr).not.toContain('does not exist')
  })

  it('refuses by name when an argument is missing', () => {
    const r = run([ACCOUNT, NAMESPACE])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/::error::.*usage/i)
    expect(r.calls).toEqual([])
  })
})

describe('Deploy Worker runs it before the engine deploys', () => {
  const job = workflowJobBody(readWorkflow('.github/workflows/deploy.yml'), 'deploy-worker')

  it('ensures the namespace with the names wrangler.toml binds, before wrangler deploy', () => {
    const ensure = job.indexOf('ensure-compare-namespace.sh')
    expect(ensure).toBeGreaterThan(-1)
    expect(ensure).toBeLessThan(job.indexOf('wrangler deploy --var DEPLOYED_SHA'))

    // The names are read from the configs the deploys use, so a rename in one
    // place fails here rather than leaving the step checking a stale name (L41).
    const toml = readFileSync(path.join(REPO_ROOT, 'apps/worker/wrangler.toml'), 'utf8')
    const block = toml.split('[[dispatch_namespaces]]').find((b) => /binding\s*=\s*"COMPARE_CODE_LOADER"/.test(b)) ?? ''
    const namespace = /\bnamespace\s*=\s*"([^"]+)"/.exec(block)?.[1]
    const outbound = /outbound\s*=\s*\{\s*service\s*=\s*"([^"]+)"/.exec(block)?.[1]
    const account = /^account_id\s*=\s*"([^"]+)"/m.exec(toml)?.[1]
    const outboundName = /^name\s*=\s*"([^"]+)"/m.exec(readFileSync(path.join(REPO_ROOT, 'apps/compare-outbound/wrangler.toml'), 'utf8'))?.[1]
    expect([namespace, outbound, account]).not.toContain(undefined)
    expect(outbound).toBe(outboundName)
    const args = /ensure-compare-namespace\.sh "?([^"\s]+)"? "?([^"\s]+)"? "?([^"\s]+)"?/.exec(job)?.slice(1)
    expect(args).toEqual([account, namespace, outbound])
  })

  it('waits for Deploy Compare Outbound, so a fresh account has the outbound Worker first', () => {
    expect(job).toMatch(/needs:\s*\[[^\]]*deploy-compare-outbound[^\]]*\]/)
  })
})
