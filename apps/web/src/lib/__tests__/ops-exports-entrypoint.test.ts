/**
 * .github/scripts/ops-exports-entrypoint.mjs (#2335, PR 9 of phase 5): before a
 * change to the bidding Worker's OPS_CONNECTIONS binding (or to the ops Worker)
 * merges, read the DEPLOYED ops script through the Cloudflare API and confirm it
 * exports the OpsConnections entrypoint with every method bidding calls. The
 * repo cannot answer this: Cloudflare deploys a binding to an entrypoint the
 * deployed Worker lacks green, and every call then throws (spike #2330).
 *
 * The fixture is the shape the API really answered for bidspoke-worker-ops on
 * 2026-10-19 (the 01:52 UTC deploy of #2456): content/v2 is a multipart body
 * with one part, index.js; the class is `var OpsConnections = class extends
 * WorkerEntrypoint2 {` (the bundler renamed the second import of
 * WorkerEntrypoint), opening with a `static { __name(...) }` block; the export
 * list is one `export { ... }` at the end, followed by the source map comment
 * (split in two here, or Vite would try to load the map). The same read taken at 01:38 UTC,
 * before that deploy, held no OpsConnections at all, which is the red case.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC } from './_scan-utils'
import {
  ENTRYPOINT, METHODS, bindingCheckNeeded, checkDeployedOps, entrypointVerdict, mainModuleOf,
} from '../../../../../.github/scripts/ops-exports-entrypoint.mjs'

const CLASS = `var OpsConnections = class extends WorkerEntrypoint2 {
  static {
    __name(this, "OpsConnections");
  }
  verify(request) {
    return opsConnectionsAnswer(this.env, "verify", request, parseVerifyRequest);
  }
  clearReauth(request) {
    return opsConnectionsAnswer(this.env, "clearReauth", request, parseClearReauthRequest);
  }
  revoke(request) {
    return opsConnectionsAnswer(this.env, "revoke", request, parseRevokeRequest);
  }
  health(request) {
    return opsConnectionsAnswer(this.env, "health", request, parseHealthRequest);
  }
  lookup(request) {
    return opsConnectionsAnswer(this.env, "lookup", request, parseLookupRequest);
  }
  exchangeOAuthCode(request) {
    return opsConnectionsAnswer(this.env, "exchangeOAuthCode", request, parseExchangeOAuthCodeRequest);
  }
};
`
const EXPORTS_WITH = `export {
  ConnectionTokenObject,
  MAX_BODY_BYTES,
  OPS_IDENTITY_HEADER,
  OPS_LANE,
  OpsConnections,
  OpsInternal,
  createOpsHandler,
  index_default as default,
  scheduledTick
};
${'//# source'}${'MappingURL=index.js.map'}
`
const EXPORTS_WITHOUT = EXPORTS_WITH.replace('  OpsConnections,\n', '')
const PRELUDE = `import { WorkerEntrypoint } from "cloudflare:workers";
import { WorkerEntrypoint as WorkerEntrypoint2 } from "cloudflare:workers";
var OpsInternal = class extends WorkerEntrypoint {
  static {
    __name(this, "OpsInternal");
  }
  ping() {
    return opsInternalIdentity(this.env);
  }
};
`
const DEPLOYED = `${PRELUDE}${CLASS}\n// src/ops/index.ts\nvar OPS_LANE = "ops";\n${EXPORTS_WITH}`
const BEFORE_2456 = `${PRELUDE}\n// src/ops/index.ts\nvar OPS_LANE = "ops";\n${EXPORTS_WITHOUT}`

const multipart = (module: string, boundary = 'd28ee68c2356ba3b54c8674af8f8084af5ffdf75bf0f37cbd1d477c97e5d') =>
  `--${boundary}\r\nContent-Disposition: form-data; name="index.js"; filename="index.js"\r\nContent-Type: application/javascript+module\r\n\r\n${module}\r\n--${boundary}--\r\n`

/**
 * OPS_CONNECTIONS_METHODS read from the contract's source, not imported: the
 * contract's type imports would pull worker modules into the web typecheck.
 */
function contractMethods(): string[] {
  const src = readFileSync(path.join(WORKER_SRC, 'lib/ops-connections-contract.ts'), 'utf8')
  const list = /export const OPS_CONNECTIONS_METHODS = \[([^\]]*)\] as const/.exec(src)?.[1]
  if (!list) throw new Error('ops-connections-contract.ts declares no OPS_CONNECTIONS_METHODS list')
  return [...list.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1])
}

describe('the methods it requires are the contract\'s', () => {
  it('names OpsConnections and exactly OPS_CONNECTIONS_METHODS', () => {
    expect(ENTRYPOINT).toBe('OpsConnections')
    expect(contractMethods()).toHaveLength(6)
    expect([...METHODS].sort()).toEqual(contractMethods().sort())
  })
})

describe('mainModuleOf', () => {
  it('reads the one module out of the multipart body the API answers', () => {
    expect(mainModuleOf(multipart(DEPLOYED))).toBe(DEPLOYED)
  })

  it('prefers index.js when there are several JavaScript modules', () => {
    const b = 'abc'
    const body = `--${b}\r\nContent-Disposition: form-data; name="chunk.js"; filename="chunk.js"\r\nContent-Type: application/javascript+module\r\n\r\nexport const x = 1\r\n`
      + `--${b}\r\nContent-Disposition: form-data; name="index.js"; filename="index.js"\r\nContent-Type: application/javascript+module\r\n\r\n${DEPLOYED}\r\n--${b}--\r\n`
    expect(mainModuleOf(body)).toBe(DEPLOYED)
  })

  it('refuses a body with no module rather than reading nothing as a pass', () => {
    expect(() => mainModuleOf('not multipart at all')).toThrow(/no JavaScript module/)
  })
})

describe('entrypointVerdict', () => {
  it('passes the script as deployed by #2456', () => {
    expect(entrypointVerdict(DEPLOYED)).toEqual({ ok: true, lines: [expect.stringContaining('exports OpsConnections, a WorkerEntrypoint, with verify, clearReauth, revoke, health, lookup, exchangeOAuthCode')] })
  })

  it('fails the script as deployed before #2456, which exported no OpsConnections', () => {
    const verdict = entrypointVerdict(BEFORE_2456)
    expect(verdict.ok).toBe(false)
    expect(verdict.lines.join('\n')).toMatch(/does not export OpsConnections/)
  })

  it('fails a class that is exported but is not a WorkerEntrypoint', () => {
    const verdict = entrypointVerdict(DEPLOYED.replace('class extends WorkerEntrypoint2 {\n  static {\n    __name(this, "OpsConnections")', 'class extends Base {\n  static {\n    __name(this, "OpsConnections")'))
    expect(verdict.ok).toBe(false)
    expect(verdict.lines.join('\n')).toMatch(/not a class extending WorkerEntrypoint/)
  })

  it('fails, naming it, a method bidding calls that the deployed class lacks', () => {
    const verdict = entrypointVerdict(DEPLOYED.replace(/ {2}lookup\(request\) \{\n.*\n {2}\}\n/, ''))
    expect(verdict.ok).toBe(false)
    expect(verdict.lines.join('\n')).toMatch(/lacks lookup/)
  })

  it('follows an export under another local name', () => {
    const renamed = DEPLOYED.replace('var OpsConnections = class', 'var OpsConnections3 = class').replace('  OpsConnections,\n', '  OpsConnections3 as OpsConnections,\n')
    expect(entrypointVerdict(renamed).ok).toBe(true)
  })

  it('reads a brace inside a string in a method without losing the class body', () => {
    const braced = DEPLOYED.replace('return opsConnectionsAnswer(this.env, "verify"', 'const s = "} {"; return opsConnectionsAnswer(this.env, "verify"')
    expect(entrypointVerdict(braced).ok).toBe(true)
  })
})

describe('checkDeployedOps', () => {
  const ACCOUNT = '3e7f907a9c19e51417873e2cce4fbc5c'
  function api(opts: { deployments?: unknown; deploymentsStatus?: number; content?: string; contentStatus?: number }) {
    const calls: string[] = []
    const fetchFn = async (url: string, init: { headers: Record<string, string> }) => {
      calls.push(url)
      expect(init.headers.Authorization).toBe('Bearer test-token-value')
      if (url.endsWith('/deployments')) {
        return new Response(JSON.stringify(opts.deployments ?? { success: true, errors: [], result: { deployments: [
          { id: 'b', created_on: '2026-10-19T01:52:16.436889Z', versions: [{ version_id: 'v2', percentage: 100 }] },
          { id: 'a', created_on: '2026-10-19T01:38:24.883126Z', versions: [{ version_id: 'v1', percentage: 100 }] },
        ] } }), { status: opts.deploymentsStatus ?? 200 })
      }
      return new Response(opts.content ?? multipart(DEPLOYED), { status: opts.contentStatus ?? 200 })
    }
    return { fetchFn, calls }
  }

  it('reads the latest deployment, then the script content, and passes the deployed export', async () => {
    const { fetchFn, calls } = api({})
    const verdict = await checkDeployedOps(fetchFn, 'test-token-value', ACCOUNT)
    expect(verdict.ok).toBe(true)
    expect(verdict.lines[0]).toContain('v2')
    expect(calls).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/bidspoke-worker-ops/deployments`,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/bidspoke-worker-ops/content/v2`,
    ])
  })

  it('fails on the script as it was before the entrypoint shipped', async () => {
    const { fetchFn } = api({ content: multipart(BEFORE_2456) })
    expect((await checkDeployedOps(fetchFn, 'test-token-value', ACCOUNT)).ok).toBe(false)
  })

  it('fails, unmeasured, on a split deployment, since the content read cannot say which version it is', async () => {
    const { fetchFn } = api({ deployments: { success: true, errors: [], result: { deployments: [
      { id: 'c', created_on: '2026-10-19T02:00:00Z', versions: [{ version_id: 'v2', percentage: 90 }, { version_id: 'v1', percentage: 10 }] },
    ] } } })
    const verdict = await checkDeployedOps(fetchFn, 'test-token-value', ACCOUNT)
    expect(verdict.ok).toBe(false)
    expect(verdict.lines.join('\n')).toMatch(/split across 2 versions/)
  })

  it('fails naming the status when the API refuses, never reading a refusal as a pass', async () => {
    const { fetchFn } = api({ deploymentsStatus: 403, deployments: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } })
    await expect(checkDeployedOps(fetchFn, 'test-token-value', ACCOUNT)).rejects.toThrow(/403.*Authentication error/)
    const second = api({ contentStatus: 500, content: 'oops' })
    await expect(checkDeployedOps(second.fetchFn, 'test-token-value', ACCOUNT)).rejects.toThrow(/content.*500/)
  })

  it('fails when the ops Worker has no deployment at all', async () => {
    const { fetchFn } = api({ deployments: { success: true, errors: [], result: { deployments: [] } } })
    await expect(checkDeployedOps(fetchFn, 'test-token-value', ACCOUNT)).rejects.toThrow(/no deployment/)
  })
})

describe('bindingCheckNeeded: which pull requests it measures', () => {
  it.each([
    ['apps/worker/wrangler.toml'],
    ['apps/worker/wrangler.ops.toml'],
    ['apps/worker/src/ops/index.ts'],
    ['apps/worker/src/lib/ops-connections-client.ts'],
    ['apps/worker/src/lib/ops-connections-contract.ts'],
    ['.github/scripts/ops-exports-entrypoint.mjs'],
  ])('measures a pull request touching %s', (file) => {
    expect(bindingCheckNeeded([file], true)).toBe(true)
  })

  it('leaves one touching only the engine or the web app alone, so ops can never hold up a money hotfix', () => {
    expect(bindingCheckNeeded(['apps/worker/src/engine/index.ts', 'apps/web/src/app/page.tsx'], true)).toBe(false)
  })

  it('measures when the file list could not be read, rather than skipping on nothing', () => {
    expect(bindingCheckNeeded([], false)).toBe(true)
  })
})
