import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listFiles, REPO_ROOT } from '../../__tests__/_scan-utils'

/**
 * Issue #764. `deploy.yml` checks that migrations are APPLIED, never that the
 * database objects the shipping code depends on actually exist and carry the
 * permissions it assumes. Those are different questions, and both near misses on
 * 2026-08-13 were in the gap: a migration's comment asserted `anon` was excluded
 * from a security-definer function while Postgres had granted EXECUTE to PUBLIC
 * anyway, and only a live privilege query caught it (LESSONS L124).
 *
 * It matters because `apps/web/src/middleware.ts` calls `is_allowlisted()` on
 * every protected request. If that function were missing or its grant wrong,
 * every employee would hit /access-denied with `gate_unavailable` while the
 * pipeline reported a clean deploy throughout.
 *
 * The check runs against the LIVE database with nothing but the public anon key,
 * which is already a repo variable. PostgREST distinguishes the two failure
 * modes cleanly, measured against prod on 2026-08-14:
 *
 *   exists, anon EXECUTE revoked -> HTTP 401, code 42501
 *   not present (or wrong args)  -> HTTP 404, code PGRST202
 *   anon may execute it          -> HTTP 2xx
 *
 * This complements `security-definer-grants.test.ts`, which reads the
 * migrations. That guard cannot see a function no migration in this repo creates
 * (it says so about `rls_auto_enable`), and it cannot see a REVOKE that was
 * written but did not take effect. The live side sees both.
 *
 * THE ARGUMENT NAMES MATTER, and this is the trap that would otherwise make the
 * whole check useless. Measured: `auth_user_with_allowlist` probed with an empty
 * body returns PGRST202, indistinguishable from missing, and returns 42501 only
 * when given its real `p_user_id`. A prober that sends `{}` would therefore
 * report most of the app's own RPCs as absent. So the manifest carries the
 * argument shape the app actually sends.
 */
const scriptPath = path.join(REPO_ROOT, '.github/scripts/db-object-decision.sh')
const MANIFEST = path.join(REPO_ROOT, 'supabase/required-live-objects.json')

function decide(httpCode: string, pgCode: string, expectedAnon: string): string {
  return execFileSync('bash', [scriptPath, httpCode, pgCode, expectedAnon], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

describe('db-object-decision: the object exists and carries the expected grant (#764)', () => {
  it('passes a function that exists and correctly denies anon', () => {
    expect(decide('401', '42501', 'denied')).toBe('ok')
  })

  it('passes a function that exists and is deliberately callable by anon', () => {
    expect(decide('200', '', 'allowed')).toBe('ok')
  })

  it('fails when the function is not present', () => {
    expect(decide('404', 'PGRST202', 'denied')).toBe('missing')
  })

  it('fails when a function meant to deny anon can be executed by anon', () => {
    // The #764 case: a REVOKE that was written but did not take effect, which is
    // invisible in review because the evidence is an absent line.
    expect(decide('200', '', 'denied')).toBe('anon_can_execute')
  })

  it('fails when the function is missing even though anon was allowed to call it', () => {
    // A deliberately-callable function still has to exist.
    expect(decide('404', 'PGRST202', 'allowed')).toBe('missing')
  })
})

describe('db-object-decision: an unreadable probe is its own outcome (#764)', () => {
  it('reports unreachable rather than ok when there is no HTTP status', () => {
    // Finding nothing must never read as success (LESSONS L98). This job runs
    // AFTER the deploy, so it is an alarm rather than a gate, and a database it
    // cannot reach at all is itself worth waking someone for.
    expect(decide('', '', 'denied')).toBe('unreachable')
    expect(decide('000', '', 'denied')).toBe('unreachable')
  })

  it('reports unreachable on a gateway error from the platform, not a missing object', () => {
    // A 502 from in front of PostgREST says nothing about whether the function
    // exists, so it must not be reported as missing.
    expect(decide('502', '', 'denied')).toBe('unreachable')
    expect(decide('503', '', 'denied')).toBe('unreachable')
    expect(decide('504', '', 'denied')).toBe('unreachable')
  })

  it('reports an unexpected shape distinctly instead of guessing', () => {
    // A 401 that is NOT a privilege error (a rejected apikey, say) means the
    // probe never reached the question. Claiming the grant is correct on that
    // basis would be a message claiming more than it measured (LESSONS L11).
    expect(decide('401', 'PGRST301', 'denied')).toBe('probe_rejected')
  })

  it('never exits non-zero itself, so the caller owns the verdict', () => {
    for (const args of [['401', '42501', 'denied'], ['404', 'PGRST202', 'denied'], ['', '', 'denied'], []]) {
      expect(() => execFileSync('bash', [scriptPath, ...args], { stdio: 'pipe' })).not.toThrow()
    }
  })

  it('prints exactly one word', () => {
    for (const args of [['401', '42501', 'denied'], ['200', '', 'denied'], ['', '', 'allowed']]) {
      const out = execFileSync('bash', [scriptPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      expect(out.trim().split('\n')).toHaveLength(1)
      expect(['ok', 'missing', 'anon_can_execute', 'unreachable', 'probe_rejected']).toContain(out.trim())
    }
  })
})

// ── The manifest has to stay complete ────────────────────────────────────────

interface ManifestEntry {
  name: string
  args: Record<string, unknown>
  anon: 'denied' | 'allowed'
  reason?: string
}

function manifest(): ManifestEntry[] {
  return JSON.parse(readFileSync(MANIFEST, 'utf8')) as ManifestEntry[]
}

/**
 * Every `.rpc('name')` in shipping source, which is what the app depends on.
 *
 * The walk goes through the shared `listFiles`, which knows which directories
 * hold tests. It used to carry its own copy of that list, and the copy went
 * stale the moment a second test directory existed: it read a fake client out of
 * a guard's own fixture and reported an RPC called `name` as a live dependency
 * (#502). One implementation, so there is nothing left to drift.
 */
function rpcsCalledByTheApp(): Set<string> {
  const found = new Set<string>()
  const roots = [path.join(REPO_ROOT, 'apps/worker/src'), path.join(REPO_ROOT, 'apps/web/src')]
  for (const root of roots) {
    for (const file of listFiles(root, { exts: ['.ts', '.tsx'] })) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/\.rpc\(\s*['"`]([a-z0-9_]+)['"`]/gi)) found.add(m[1])
    }
  }
  return found
}

describe('the required-objects manifest is derived, not remembered (#764)', () => {
  it('finds the app RPC calls at all, so this cannot pass vacuously', () => {
    // A broken matcher would report an empty set and every completeness check
    // below would pass while covering nothing.
    const called = rpcsCalledByTheApp()
    expect(called.size).toBeGreaterThan(5)
    expect(called).toContain('is_allowlisted')
    expect(called).toContain('auth_user_with_allowlist')
  })

  it('lists every RPC the shipping code calls', () => {
    // The code-to-manifest direction, which is the one a hand-written registry
    // always gets wrong: the entries you remembered are the ones already safe
    // (LESSONS L96).
    const listed = new Set(manifest().map((e) => e.name))
    const missing = [...rpcsCalledByTheApp()].filter((n) => !listed.has(n))
    expect(missing, `these RPCs are called but not in ${path.basename(MANIFEST)}`).toEqual([])
  })

  it('carries an argument shape for every entry, since an empty body reads as missing', () => {
    for (const e of manifest()) {
      expect(e.args, `${e.name} has no args object`).toBeDefined()
      expect(typeof e.args).toBe('object')
    }
  })

  it('states a reason for every entry that anon is allowed to call', () => {
    // An exemption with no stated reason is how a guard quietly stops guarding
    // (LESSONS L65).
    for (const e of manifest().filter((x) => x.anon === 'allowed')) {
      expect(e.reason?.length ?? 0, `${e.name} is anon-allowed with no reason`).toBeGreaterThan(20)
    }
  })

  it('only uses the two anon expectations the decision script understands', () => {
    for (const e of manifest()) {
      expect(['denied', 'allowed']).toContain(e.anon)
    }
  })
})

describe('deploy.yml runs the live assertion after deploying (#764)', () => {
  function stripYamlComments(yml: string): string {
    return yml.split('\n').map((l) => {
      const m = /^(\s*)#/.exec(l)
      return m ? m[1] : l.replace(/\s+#.*$/, '')
    }).join('\n')
  }

  function jobBlock(name: string): string {
    const wf = stripYamlComments(readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8'))
    const start = wf.search(new RegExp(`^  ${name}:$`, 'm'))
    expect(start, `deploy.yml has no job named ${name}`).toBeGreaterThan(-1)
    const rest = wf.slice(start + 1)
    const next = rest.search(/^ {2}[A-Za-z_][\w-]*:$/m)
    return next === -1 ? rest : rest.slice(0, next)
  }

  it('has a job that runs the assertion script', () => {
    expect(jobBlock('assert-db-objects')).toContain('assert-live-db-objects')
  })

  it('runs after the deploys, so it checks what actually shipped', () => {
    // Asserting before the deploy would measure the previous release.
    const job = jobBlock('assert-db-objects')
    expect(job).toMatch(/needs:\s*\[[^\]]*deploy-worker[^\]]*\]/)
    expect(job).toContain('always()')
  })

  it('reads the manifest rather than an inline list', () => {
    expect(jobBlock('assert-db-objects')).toContain('required-live-objects.json')
  })
})

describe('the assertion refuses a manifest it cannot read (#764)', () => {
  const assertScript = path.join(REPO_ROOT, '.github/scripts/assert-live-db-objects.sh')

  function runAgainst(contents: string): number {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dbobj-'))
    const file = path.join(dir, 'manifest.json')
    writeFileSync(file, contents)
    try {
      execFileSync('bash', [assertScript, file], {
        stdio: 'pipe',
        env: { ...process.env, SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'x' },
      })
      return 0
    } catch (e) {
      return (e as { status?: number }).status ?? -1
    }
  }

  it.each([
    ['null', 'null'],
    ['an empty array', '[]'],
    ['an object rather than an array', '{}'],
    ['not JSON at all', 'not json at all'],
  ])('exits non-zero for %s rather than reporting success', (_label, contents) => {
    // A manifest that parses to nothing, or does not parse, must never read as a
    // clean pass. `jq length` prints `null` for some of these, and `[ "null" -lt 1 ]`
    // is a bash arithmetic ERROR rather than a false, which without this guard let
    // the loop run zero times and the script report success (LESSONS L50, L98).
    expect(runAgainst(contents)).not.toBe(0)
  })

  it('exits non-zero for a missing manifest file', () => {
    let code = 0
    try {
      execFileSync('bash', [assertScript, '/nonexistent/manifest.json'], {
        stdio: 'pipe',
        env: { ...process.env, SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'x' },
      })
    } catch (e) {
      code = (e as { status?: number }).status ?? -1
    }
    expect(code).not.toBe(0)
  })
})
