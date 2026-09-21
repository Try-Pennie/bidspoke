import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * Issue #727. `deploy.yml`'s paths filter lists `pnpm-lock.yaml` and
 * `package.json` under the worker filter, so a web-only dependency bump
 * redeploys the production bidding engine with no worker source change at all
 * (confirmed live on 2026-07-30 merging #706, a test-only devDependency).
 *
 * Narrowing the filter is only a heuristic, because pnpm can genuinely
 * re-resolve a shared transitive dependency and move the worker bundle. So the
 * gate compares the built artifact instead: build at the live worker's reported
 * commit and at HEAD, and deploy only when the bytes differ. That is the correct
 * trigger by construction (LESSONS L40: compare the content, never a stand-in).
 *
 * The decision lives in a script so its branches are testable, because the ones
 * that matter are the ones a green pipeline would otherwise hide.
 *
 * THE FAIL-SAFE DIRECTION IS "DEPLOY", and it is the opposite of most gates.
 * Every uncertainty (an unreadable live commit, a commit not in this history, a
 * build that produced no hash) must deploy. Skipping on an unreadable signal is
 * the dangerous half: it strands the engine behind a green pipeline, which is
 * the exact defect #327 and the Deploy Drift check exist to catch. An
 * unnecessary redeploy is merely wasteful.
 */
const scriptPath = path.join(REPO_ROOT, '.github/scripts/worker-artifact-decision.sh')

function run(...args: string[]): { decision: string; reason: string } {
  // stdout carries the decision, stderr the human reason, so the workflow can
  // branch on one and log the other. BOTH are captured: this used to return an
  // always-empty `reason` from a list nothing wrote to, so every assertion about
  // the reason passed on nothing and the test claiming the script explains itself
  // only ever read stdout (#1420, L178).
  const res = spawnSync('bash', [scriptPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { decision: (res.stdout ?? '').trim(), reason: (res.stderr ?? '').trim() }
}

function decide(...args: string[]): string {
  return run(...args).decision
}

const SHA = 'a'.repeat(40)
const HASH_A = '1'.repeat(64)
const HASH_B = '2'.repeat(64)
const CFG_A = '3'.repeat(64)
const CFG_B = '4'.repeat(64)

describe('worker-artifact-decision: deploys only when the built artifact moved (#727)', () => {
  it('deploys when the two builds hash differently', () => {
    expect(decide(SHA, 'true', HASH_A, HASH_B, CFG_A, CFG_A)).toBe('deploy')
  })

  it('skips when the two builds are byte identical', () => {
    expect(decide(SHA, 'true', HASH_A, HASH_A, CFG_A, CFG_A)).toBe('skip')
  })
})

/**
 * The DEPLOY-TIME CONFIGURATION dimension (#1420).
 *
 * The bundle is not the whole of what a deploy changes. `wrangler.toml` carries
 * `[vars]`, `[triggers]` crons, `[limits]` and every binding, and none of them
 * appear in `dist/index.js`: they are applied BY the deploy. So a change to any
 * of them leaves the bundle byte identical, and a gate that compares only the
 * bundle skips the one deploy that would have shipped it, behind a green
 * pipeline.
 *
 * Measured on 2026-09-21: #1404 set `PARTNER_PROBE_ALERTS = "on"` in
 * wrangler.toml and changed one source comment. Deploy reported success, Deploy
 * Worker was skipped, and an hour later the probe was still logging
 * `mode=observe` on the same script version. The flip had merged and was not
 * live.
 *
 * Both dimensions are compared, and each one names ITSELF in the reason, so a
 * reader can tell a config deploy from a code deploy (L11).
 */
describe('worker-artifact-decision: the deploy-time configuration counts too (#1420)', () => {
  it('deploys when only the configuration moved, with the bundle identical', () => {
    expect(decide(SHA, 'true', HASH_A, HASH_A, CFG_A, CFG_B)).toBe('deploy')
  })

  it('names the configuration as what moved, not the artifact', () => {
    const { reason } = run(SHA, 'true', HASH_A, HASH_A, CFG_A, CFG_B)
    expect(reason).toMatch(/config/i)
    expect(reason).not.toMatch(/artifact changed/i)
  })

  it('names the artifact as what moved when only the bundle moved', () => {
    const { reason } = run(SHA, 'true', HASH_A, HASH_B, CFG_A, CFG_A)
    expect(reason).toMatch(/artifact/i)
  })

  it('skips only when BOTH the bundle and the configuration are identical', () => {
    expect(decide(SHA, 'true', HASH_A, HASH_A, CFG_A, CFG_A)).toBe('skip')
  })

  it('deploys when a configuration hash is missing, rather than reading two blanks as a match', () => {
    expect(decide(SHA, 'true', HASH_A, HASH_A, '', '')).toBe('deploy')
    expect(decide(SHA, 'true', HASH_A, HASH_A, CFG_A, '')).toBe('deploy')
    expect(decide(SHA, 'true', HASH_A, HASH_A, '', CFG_A)).toBe('deploy')
  })

  // Omission must be impossible rather than merely discouraged (L621): a caller
  // that forgets the config hashes is the exact blindness this fixes, so the
  // script refuses the old four argument form instead of silently ignoring it.
  it('deploys when called with the old four argument form', () => {
    expect(decide(SHA, 'true', HASH_A, HASH_A)).toBe('deploy')
  })
})

describe('worker-artifact-decision: every uncertainty deploys rather than skips (#727)', () => {
  it('deploys when the live worker reports no deployed commit', () => {
    expect(decide('unknown', 'false', HASH_A, '', CFG_A, CFG_A)).toBe('deploy')
  })

  it('deploys when the live commit is empty, e.g. the worker was unreachable', () => {
    expect(decide('', 'false', HASH_A, '', CFG_A, CFG_A)).toBe('deploy')
  })

  it('deploys when the live commit is not in this repository history', () => {
    expect(decide(SHA, 'false', HASH_A, '', CFG_A, CFG_A)).toBe('deploy')
  })

  it('deploys when the live commit is outside this history even if a hash pair matches', () => {
    // Also found by mutation-checking. With a hash for a commit this repository
    // cannot see, the pair is unattributable, so a match means nothing. Every
    // other in-history test happened to pass an empty live hash as well, so a
    // second check covered for this branch and removing it stayed green.
    expect(decide(SHA, 'false', HASH_A, HASH_A, CFG_A, CFG_A)).toBe('deploy')
    expect(decide(SHA, 'anything-but-true', HASH_A, HASH_A, CFG_A, CFG_A)).toBe('deploy')
  })

  it('deploys when the HEAD build produced no hash', () => {
    expect(decide(SHA, 'true', '', HASH_A, CFG_A, CFG_A)).toBe('deploy')
  })

  it('deploys when the live-commit build produced no hash', () => {
    expect(decide(SHA, 'true', HASH_A, '', CFG_A, CFG_A)).toBe('deploy')
  })

  it('deploys when neither build produced a hash, rather than reading two blanks as a match', () => {
    // The trap this pins: two failed builds both yield '', and a naive equality
    // check would call that "identical" and skip the deploy.
    expect(decide(SHA, 'true', '', '', CFG_A, CFG_A)).toBe('deploy')
  })

  it('deploys when the live commit is unreadable even though the hashes happen to match', () => {
    // Precedence: an untrustworthy input beats a matching comparison, because a
    // hash pair that cannot be attributed to a known commit proves nothing.
    expect(decide('unknown', 'false', HASH_A, HASH_A, CFG_A, CFG_A)).toBe('deploy')
  })

  it('deploys on an inconsistent pair: an unknown live commit reported as in-history', () => {
    // Found by mutation-checking. Removing the unknown-SHA branch left every
    // other test green, because the caller always sets in_history=false when the
    // SHA is unknown, so a second check happened to cover for it. This is the one
    // input that separates them, and without the branch it SKIPS the deploy on a
    // commit nobody can identify.
    expect(decide('unknown', 'true', HASH_A, HASH_A, CFG_A, CFG_A)).toBe('deploy')
    expect(decide('', 'true', HASH_A, HASH_A, CFG_A, CFG_A)).toBe('deploy')
    expect(decide('null', 'true', HASH_A, HASH_A, CFG_A, CFG_A)).toBe('deploy')
  })

  it('deploys when called with no arguments at all', () => {
    expect(decide()).toBe('deploy')
  })

  it('deploys when called with too few arguments', () => {
    expect(decide(SHA, 'true')).toBe('deploy')
  })
})

describe('worker-artifact-decision: never fails the pipeline itself (#727)', () => {
  it('exits 0 on every input, so a gate problem cannot block a deploy', () => {
    const inputs = [
      [SHA, 'true', HASH_A, HASH_B],
      [SHA, 'true', HASH_A, HASH_A],
      ['unknown', 'false', '', ''],
      [],
      ['!!not-a-sha!!', 'maybe', 'x', 'y'],
    ]
    for (const args of inputs) {
      expect(() => execFileSync('bash', [scriptPath, ...args], { stdio: 'pipe' })).not.toThrow()
    }
  })

  it('prints exactly one of deploy or skip and nothing else on stdout', () => {
    // The workflow branches on this string, so a stray log line on stdout would
    // silently make every comparison read as "not skip".
    for (const args of [[SHA, 'true', HASH_A, HASH_B], [SHA, 'true', HASH_A, HASH_A], []]) {
      const out = execFileSync('bash', [scriptPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      expect(out.trim().split('\n')).toHaveLength(1)
      expect(['deploy', 'skip']).toContain(out.trim())
    }
  })

  it('explains itself on stderr, so a skipped deploy is never unexplained', () => {
    // A gate that silently declines to ship is indistinguishable from a broken
    // pipeline when someone comes looking for their change. This reads the
    // STDERR it is named for; it previously asserted only that stdout said
    // 'skip', so the explanation it exists to require was never checked.
    const { decision, reason } = run(SHA, 'true', HASH_A, HASH_A, CFG_A, CFG_A)
    expect(decision).toBe('skip')
    expect(reason).not.toBe('')
    expect(reason).toContain('skip')
  })

  it('explains every decision, not only the skip', () => {
    for (const args of [
      [SHA, 'true', HASH_A, HASH_B, CFG_A, CFG_A],
      [SHA, 'true', HASH_A, HASH_A, CFG_A, CFG_B],
      [SHA, 'false', HASH_A, HASH_A, CFG_A, CFG_A],
      [],
    ]) {
      const { decision, reason } = run(...args)
      expect(reason, `no reason given for ${JSON.stringify(args)}`).not.toBe('')
      expect(reason).toContain(decision)
    }
  })
})

describe('deploy.yml wires the gate in (#727)', () => {
  const workflow = () => readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8')

  /** Blank YAML comments, keeping line structure so offsets stay readable. */
  function stripYamlComments(yml: string): string {
    return yml
      .split('\n')
      .map((line) => {
        const m = /^(\s*)#/.exec(line)
        if (m) return m[1]
        return line.replace(/\s+#.*$/, '')
      })
      .join('\n')
  }

  /**
   * The text of ONE job, from its `  <name>:` header to the next job header,
   * with comments removed.
   *
   * Both halves were learned the hard way while writing this.
   *
   * Scoping: a file-wide `toContain('always()')` passed even with always()
   * deleted from deploy-worker, because another job in the same file uses it.
   *
   * Comment stripping: the "no shared pnpm cache" assertion then failed against a
   * correct workflow, because the comment EXPLAINING that the cache is omitted
   * contains the literal string being forbidden. A guard that matches raw text
   * cannot tell the thing from prose about the thing (LESSONS L103).
   */
  function jobBlock(name: string): string {
    const wf = stripYamlComments(workflow())
    const start = wf.search(new RegExp(`^  ${name}:$`, 'm'))
    expect(start, `deploy.yml has no job named ${name}`).toBeGreaterThan(-1)
    const rest = wf.slice(start + 1)
    const next = rest.search(/^ {2}[A-Za-z_][\w-]*:$/m)
    return next === -1 ? rest : rest.slice(0, next)
  }

  it('scopes a job block to that job only, so these assertions cannot pass on a sibling job', () => {
    // Pins the helper itself. deploy-pages must not leak into deploy-worker.
    expect(jobBlock('deploy-worker')).not.toContain('next-on-pages')
    expect(jobBlock('deploy-worker')).toContain('Deploy Worker')
    expect(jobBlock('worker_artifact')).not.toContain('wrangler deploy')
  })

  it('strips comments, so prose about a setting is never read as the setting', () => {
    const sample = "  a:\n    # cache: 'pnpm' is deliberately omitted\n    steps: []\n  b:\n"
    expect(stripYamlComments(sample)).not.toContain("cache: 'pnpm'")
    expect(stripYamlComments(sample)).toContain('steps: []')
  })

  // The blindness was in the CALLER, not the decision script, so the wiring is
  // what has to be held in place (#1420).
  it('hashes the deploy-time config on BOTH sides, not just the bundle', () => {
    const gate = jobBlock('worker_artifact')
    expect(gate).toContain('worker-config-hash.sh')
    // Once per checkout: a hash taken on only one side has nothing to compare.
    expect(gate.match(/worker-config-hash\.sh/g) ?? []).toHaveLength(2)
  })

  it('passes both config hashes to the decision script, head first', () => {
    const gate = jobBlock('worker_artifact')
    const call = gate.slice(gate.indexOf('worker-artifact-decision.sh'))
    const argOrder = [...call.matchAll(/steps\.(head|live)_build\.outputs\.(config_hash|hash)/g)]
      .map((m) => `${m[1]}.${m[2]}`)
    // The script's own signature: head_hash live_hash head_config live_config.
    // Two same-typed pairs are transposable, so the order is asserted (L455).
    expect(argOrder).toEqual(['head.hash', 'live.hash', 'head.config_hash', 'live.config_hash'])
  })

  it('measures the live side with the HEAD copy of the hashing script', () => {
    // Otherwise the two sides are measured by two different implementations
    // whenever the script itself changes, and the hashes differ for that reason
    // rather than for a real one (L398).
    expect(jobBlock('worker_artifact')).toContain('../head/.github/scripts/worker-config-hash.sh')
  })

  it('runs the decision script rather than reimplementing the comparison inline', () => {
    expect(jobBlock('worker_artifact')).toContain('worker-artifact-decision.sh')
  })

  it('gates Deploy Worker on the gate job, so building it is not enough (LESSONS L3)', () => {
    expect(jobBlock('deploy-worker')).toMatch(/needs:\s*\[[^\]]*worker_artifact[^\]]*\]/)
  })

  it('skips the deploy ONLY on an explicit false, so a crashed gate still ships', () => {
    // The naive form is `changed == 'true'`, and it is wrong in the direction
    // that hurts: if the gate job itself fails, that output is empty, the
    // condition is false, and the deploy is silently skipped, stranding the
    // engine behind a green pipeline. That is the very defect the Deploy Drift
    // check (#327) exists to catch, reintroduced by the thing meant to be
    // careful. Only a gate that positively decided "identical" may stop a deploy.
    const job = jobBlock('deploy-worker')
    expect(job).toMatch(/needs\.worker_artifact\.outputs\.changed\s*!=\s*'false'/)
    expect(job).not.toMatch(/needs\.worker_artifact\.outputs\.changed\s*==\s*'true'/)
  })

  it('reaches the deploy even when the gate job failed, via always() plus an explicit verify check', () => {
    // always() is what lets a failed gate fall through to deploying, but it also
    // discards the implicit "all needs succeeded" rule, so Verify has to be
    // re-asserted by hand or a red test suite would deploy.
    const job = jobBlock('deploy-worker')
    expect(job).toContain('always()')
    expect(job).toMatch(/needs\.verify\.result\s*==\s*'success'/)
  })

  it('builds the two commits in separate checkouts, so one install cannot contaminate the other', () => {
    // Carried requirement from #725: the gate installs two different dependency
    // sets in one job, which that issue's determinism proof deliberately did not
    // cover. Separate working directories keep each build's node_modules its own.
    const job = jobBlock('worker_artifact')
    expect(job).toMatch(/^ +path: head$/m)
    expect(job).toMatch(/^ +path: live$/m)
  })

  it('does not share a dependency cache between the two installs', () => {
    // A cache shared across the two installs is the contamination route #725
    // flagged as unproven, so setup-node in this job must not enable one.
    expect(jobBlock('worker_artifact')).not.toMatch(/cache:\s*'pnpm'/)
  })

  it('hashes dist/index.js only, not the whole outdir', () => {
    // The sibling sourcemap embeds sourceRoot, which equals the --outdir path,
    // so hashing the directory would measure the harness and never match (#725).
    const job = jobBlock('worker_artifact')
    expect(job).toContain('apps/worker/dist/index.js')
    expect(job).not.toMatch(/sha256sum\s+-?\S*\s*apps\/worker\/dist\s*$/m)
  })

  it('tolerates a failed build on either side instead of failing the job', () => {
    // A build failure must leave the hash unset so the decision falls through to
    // deploying, never abort the gate job in a way that could strand the engine.
    const job = jobBlock('worker_artifact')
    expect(job.match(/::warning::/g) ?? []).toHaveLength(2)
  })
})
