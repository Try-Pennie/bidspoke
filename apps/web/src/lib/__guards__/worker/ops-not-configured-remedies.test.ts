/**
 * Every setting the ops minute tick can report not configured that is not a
 * Worker secret has a remedy of its own naming wrangler.ops.toml, the file it
 * lives in (#2869). A name with no entry in NOT_CONFIGURED_FIX gets
 * notConfiguredFix's fallback, `wrangler secret put`, which for a [vars] entry
 * such as OPS_TICK_MODE changes nothing: the next deploy puts the var back, and
 * the page stays up (L111).
 *
 * The names are derived, never listed by hand: the reported ones from every
 * `secret: 'NAME'` the ops source hands the tick, and the non secrets among
 * them as those under wrangler.ops.toml's [vars] or outside the ops Worker's
 * secret allowlist (a secret outside it fails the parity check, so a name there
 * cannot be a secret). The remedies are read from ops-gateway.ts as text,
 * because importing it here would pull Worker only types into the web
 * typecheck; it lives here rather than in the worker's own tests because it
 * reads worker source.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listTsFiles, REPO_ROOT, WORKER_SRC } from '../../__tests__/_scan-utils'
import { OPS_ALLOWED_SECRETS } from '../../../../../worker/src/lib/secret-lists'

const GATEWAY = readFileSync(path.join(WORKER_SRC, 'lib/ops-gateway.ts'), 'utf8')

/** Every name the ops source reports to the tick as an unconfigured setting. */
function reportedNames(): string[] {
  const names = new Set<string>()
  for (const file of listTsFiles(path.join(WORKER_SRC, 'ops'))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/\bsecret: '([A-Z][A-Z0-9_]*)'/g)) names.add(m[1])
  }
  return [...names].sort()
}

/** The keys under wrangler.ops.toml's [vars] table. */
function opsVars(): string[] {
  const toml = readFileSync(path.join(REPO_ROOT, 'apps/worker/wrangler.ops.toml'), 'utf8')
  const keys: string[] = []
  let inVars = false
  for (const line of toml.split('\n')) {
    if (/^\[/.test(line)) inVars = /^\[vars\]\s*$/.test(line)
    else if (inVars) {
      const m = /^([A-Z][A-Z0-9_]*)\s*=/.exec(line)
      if (m) keys.push(m[1])
    }
  }
  return keys
}

/** The reported names that are not Worker secrets, so a secret put cannot fix them. */
function reportedNonSecrets(): string[] {
  const vars = new Set(opsVars())
  return reportedNames().filter((n) => vars.has(n) || !OPS_ALLOWED_SECRETS.includes(n))
}

const STRING = `'((?:[^'\\\\]|\\\\.)*)'`

/** NOT_CONFIGURED_FIX as written: each name's remedy, a constant it names resolved to its text. */
function remedies(): Map<string, string> {
  const start = GATEWAY.indexOf('export const NOT_CONFIGURED_FIX')
  const end = GATEWAY.indexOf('\n}\n', start)
  expect(start, 'NOT_CONFIGURED_FIX is no longer a const object in ops-gateway.ts').toBeGreaterThan(-1)
  const out = new Map<string, string>()
  for (const m of GATEWAY.slice(start, end).matchAll(new RegExp(`^ {2}([A-Z][A-Z0-9_]*):\\s*(?:${STRING}|([A-Z][A-Z0-9_]*))`, 'gm'))) {
    if (m[2] !== undefined) out.set(m[1], m[2])
    else {
      const constant = new RegExp(`^const ${m[3]} =\\s*${STRING}`, 'm').exec(GATEWAY)
      expect(constant, `${m[1]} names ${m[3]}, which is not a string constant in ops-gateway.ts`).not.toBeNull()
      out.set(m[1], constant![1])
    }
  }
  return out
}

describe('the ops tick names a remedy that can fix each setting that is not a secret (#2869)', () => {
  it('reads the names, the [vars] table and the remedies, so a reshaped source fails rather than passing on nothing', () => {
    expect(opsVars()).toContain('LANE')
    expect(reportedNames()).toContain('OPS_TICK_MODE')
    expect(reportedNonSecrets().length).toBeGreaterThan(0)
    expect(remedies().get('OPS_SUPABASE_URL')).toMatch(/OPS_SUPABASE_SECRET_KEY/)
    expect(remedies().get('OPS_CONNECTIONS_PRIVATE_KEY')).toMatch(/secret put OPS_CONNECTIONS_PRIVATE_KEY/)
  })

  it('the fallback for a name with no remedy of its own is a secret put, which is why each needs one', () => {
    expect(GATEWAY).toMatch(/: `Set \$\{name\} on bidspoke-worker-ops: from apps\/worker, pipe its value into \\`pnpm exec wrangler secret put/)
  })

  it('gives each one its own remedy naming wrangler.ops.toml, never a secret put', () => {
    const written = remedies()
    for (const name of reportedNonSecrets()) {
      expect(written.has(name), `${name} has no entry in NOT_CONFIGURED_FIX, so its page says to run wrangler secret put`).toBe(true)
      expect(written.get(name), name).toMatch(/wrangler\.ops\.toml/)
      expect(written.get(name), name).not.toMatch(/secret put/)
    }
  })
})
