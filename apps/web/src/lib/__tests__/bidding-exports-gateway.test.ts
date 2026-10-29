/**
 * .github/scripts/bidding-exports-gateway.mjs (#2998, phase 2 of #2982): before
 * a change that makes the ops Worker call an OpsGateway method merges, read the
 * DEPLOYED bidding Worker's script through the Cloudflare API and confirm its
 * OpsGateway entrypoint has every method ops calls (OPS_GATEWAY_METHODS). The
 * repo cannot answer this: Cloudflare deploys a binding to a method the bound
 * Worker lacks green, and every call then throws, so an ops deploy calling
 * opsRunVariables before the bidding deploy carried it would fail every run.
 *
 * It is the ops Worker's own check (ops-exports-entrypoint.mjs) pointed the
 * other way, sharing its reading of a bundle and of the API, and its rule that
 * a pull request whose files cannot be read is skipped with a warning, never
 * held. The bundle below is written in the shape the bundler gives the ops
 * Worker's entrypoints (a `var X = class extends WorkerEntrypoint {` with a
 * `static { __name(...) }` block and one export list at the end), not a read of
 * the deployed bidding Worker.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { REPO_ROOT } from './_scan-utils'
import {
  BIDDING, GATEWAY_METHODS, GATEWAY_SPEC, checkDeployedBidding, gatewayCheckDecision,
} from '../../../../../.github/scripts/bidding-exports-gateway.mjs'
import { exportsEntrypoint } from '../../../../../.github/scripts/ops-exports-entrypoint.mjs'

const method = (name: string) => `  ${name}(request) {\n    return gatewayAnswer(this.env, "${name}", request);\n  }\n`
const gatewayClass = (methods: readonly string[]) => `var OpsGateway = class extends WorkerEntrypoint {
  static {
    __name(this, "OpsGateway");
  }
${methods.map(method).join('')}};
`
const EXPORTS = `export {
  BuyerLedger,
  OpsGateway,
  index_default as default
};
`
const PRELUDE = 'import { WorkerEntrypoint } from "cloudflare:workers";\n'
/** The bidding Worker as #3008 deployed it: every method ops calls, opsRunVariables included. */
const DEPLOYED = `${PRELUDE}${gatewayClass(GATEWAY_METHODS)}\n${EXPORTS}`
/** The bidding Worker before #3008: no opsRunVariables. */
const BEFORE_3008 = `${PRELUDE}${gatewayClass(GATEWAY_METHODS.filter((m: string) => m !== 'opsRunVariables'))}\n${EXPORTS}`

const multipart = (module: string, boundary = 'b1d2') =>
  `--${boundary}\r\nContent-Disposition: form-data; name="index.js"; filename="index.js"\r\nContent-Type: application/javascript+module\r\n\r\n${module}\r\n--${boundary}--\r\n`

describe('the bidding Worker\'s OpsGateway, read from its bundle', () => {
  it('names the bidding Worker, its OpsGateway and every method ops calls, opsRunVariables included', () => {
    expect(BIDDING).toBe('bidspoke-worker')
    expect(GATEWAY_SPEC).toMatchObject({ worker: 'bidspoke-worker', entrypoint: 'OpsGateway' })
    expect(GATEWAY_METHODS).toContain('opsRunVariables')
  })

  it('passes a bundle whose OpsGateway has every method', () => {
    expect(exportsEntrypoint(DEPLOYED, GATEWAY_SPEC)).toEqual({ ok: true, lines: [expect.stringContaining('exports OpsGateway')] })
  })

  it('fails the bundle as it was before #3008, naming opsRunVariables, which it lacks', () => {
    const verdict = exportsEntrypoint(BEFORE_3008, GATEWAY_SPEC)
    expect(verdict.ok).toBe(false)
    expect(verdict.lines.join('\n')).toMatch(/bidspoke-worker: the deployed OpsGateway lacks opsRunVariables/)
  })

  it('fails a bundle that exports no OpsGateway, naming the ops Worker\'s binding', () => {
    const verdict = exportsEntrypoint(DEPLOYED.replace('  OpsGateway,\n', ''), GATEWAY_SPEC)
    expect(verdict.ok).toBe(false)
    expect(verdict.lines.join('\n')).toMatch(/does not export OpsGateway, so every call through the ops Worker's OPS_GATEWAY binding would throw/)
  })
})

describe('checkDeployedBidding', () => {
  const ACCOUNT = '3e7f907a9c19e51417873e2cce4fbc5c'
  function api(content: string, versions: unknown[] = [{ version_id: 'v9', percentage: 100 }]) {
    const calls: string[] = []
    const fetchFn = async (url: string) => {
      calls.push(url)
      if (url.endsWith('/deployments')) {
        return new Response(JSON.stringify({ success: true, errors: [], result: { deployments: [{ id: 'd', created_on: '2026-10-29T14:10:00Z', versions }] } }))
      }
      return new Response(multipart(content))
    }
    return { fetchFn, calls }
  }

  it('reads the bidding Worker\'s latest deployment, then its script, and passes the deployed OpsGateway', async () => {
    const { fetchFn, calls } = api(DEPLOYED)
    const verdict = await checkDeployedBidding(fetchFn, 'test-token-value', ACCOUNT)
    expect(verdict.ok).toBe(true)
    expect(calls).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/bidspoke-worker/deployments`,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/bidspoke-worker/content/v2`,
    ])
  })

  it('fails on a deployed bidding Worker without the method, and unmeasured on a split deployment', async () => {
    expect((await checkDeployedBidding(api(BEFORE_3008).fetchFn, 'test-token-value', ACCOUNT)).ok).toBe(false)
    const split = await checkDeployedBidding(api(DEPLOYED, [{ version_id: 'a', percentage: 50 }, { version_id: 'b', percentage: 50 }]).fetchFn, 'test-token-value', ACCOUNT)
    expect(split.ok).toBe(false)
    expect(split.lines.join('\n')).toMatch(/NOT MEASURED/)
  })
})

describe('gatewayCheckDecision: which pull requests it measures', () => {
  const file = (filename: string) => ({ filename, patch: '+x' })

  it('measures a change to the ops Worker, the gateway contract, the ops config or either check', () => {
    for (const name of [
      'apps/worker/src/ops/tick.ts', 'apps/worker/src/lib/ops-gateway-contract.ts', 'apps/worker/wrangler.ops.toml',
      '.github/scripts/bidding-exports-gateway.mjs', '.github/scripts/ops-exports-entrypoint.mjs',
    ]) {
      expect(gatewayCheckDecision([file(name)], true), name).toEqual({ measure: true, reason: expect.stringContaining(name) })
    }
  })

  it('leaves alone one touching only the bidding engine, its config or the web app', () => {
    expect(gatewayCheckDecision([file('apps/worker/src/engine/index.ts'), file('apps/worker/wrangler.toml'), file('apps/web/src/app/page.tsx')], true)).toMatchObject({ measure: false })
  })

  it('skips, unmeasured, when the file list could not be read: never holding a pull request on it', () => {
    expect(gatewayCheckDecision([], false)).toEqual({ measure: false, unread: true, reason: expect.stringMatching(/could not be read/) })
  })
})

describe('run as the CI step runs it', () => {
  const run = (env: Record<string, string>) => spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '.github/scripts/bidding-exports-gateway.mjs'], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_TOKEN: 'not-a-real-token', PR_FILES: '', ...env },
  })

  it('skips with a warning, exiting 0, when the pull request\'s files could not be read', () => {
    const r = run({ PR_FILES_READ: 'false' })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^::warning::The deployed bidding Worker was not read: the pull request's files could not be read/m)
  })

  it('does not measure, exiting 0, a pull request that touches only the bidding engine', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pr-files-'))
    writeFileSync(path.join(dir, 'files.jsonl'), `${JSON.stringify({ filename: 'apps/worker/src/engine/index.ts', patch: '+x' })}\n`)
    const r = run({ PR_FILES_READ: 'true', PR_FILES: path.join(dir, 'files.jsonl') })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('not measured, because it changes neither the ops Worker nor the OpsGateway contract')
  })
})
