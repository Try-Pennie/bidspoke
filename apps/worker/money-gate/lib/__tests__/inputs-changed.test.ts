/**
 * Which pull requests run the money gate (#1704, L88).
 *
 * The gate is a job in ci.yml, and a job cannot carry a paths filter of its own,
 * so it starts on every pull request and decides from the changed files whether it
 * has anything to do, through .github/scripts/money-gate-inputs-changed.sh. The
 * set of paths that wakes it must cover every input the gate reads, so this test
 * DERIVES those inputs from disk (every file of the harness and fixtures, every
 * workspace package the Worker depends on) rather than trusting a list, and it
 * fails closed in every case the lookup cannot prove nothing relevant changed.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const workerRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const repoRoot = join(workerRoot, '..', '..')
const script = join(repoRoot, '.github', 'scripts', 'money-gate-inputs-changed.sh')

function decide(...args: string[]): string {
  return execFileSync('bash', [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...filesUnder(p))
    else out.push(relative(repoRoot, p))
  }
  return out
}

describe('money-gate-inputs-changed: every file the harness imports wakes it (#1708 part B)', () => {
  // The harness reads code outside apps/worker too (the compare namespace's
  // outbound Worker, whose handler answers compare bundles' requests), so the
  // files it imports are derived from its own import lines rather than listed.
  it('wakes on a change to any file a harness or gate config file imports by a relative path', () => {
    const sources = [...filesUnder(join(workerRoot, 'money-gate', 'harness')), 'apps/worker/vitest.money-gate.config.mts']
    const imported = new Set<string>()
    for (const rel of sources) {
      const text = readFileSync(join(repoRoot, rel), 'utf8')
      for (const m of text.matchAll(/^import[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
        const target = relative(repoRoot, join(repoRoot, dirname(rel), m[1]))
        imported.add(/\.[cm]?[jt]s$/.test(target) ? target : `${target}.ts`)
      }
    }
    expect(imported).toContain('apps/compare-outbound/src/index.ts')
    for (const file of imported) expect(decide('7', 'true', file), file).toBe('true')
  })
})

describe('money-gate-inputs-changed: runs on any input the gate reads, skips only on proof', () => {
  it('skips a pull request that touches nothing the gate reads', () => {
    expect(decide('7', 'true', 'apps/web/src/app/page.tsx\ndocs/runbook.md\napps/worker-tail/src/index.ts')).toBe('false')
  })

  it.each([
    'apps/worker/src/engine/index.ts',
    'apps/worker/src/lib/code-node-deployer.ts',
    'apps/worker/wrangler.toml',
    'apps/worker/package.json',
    'apps/worker/vitest.money-gate.config.mts',
    'apps/worker/vitest.money-gate-verdict.config.mts',
    'apps/worker/scripts/export-money-fixture-shapes.ts',
    'pnpm-lock.yaml',
    'package.json',
    'pnpm-workspace.yaml',
    '.github/scripts/money-gate.sh',
    '.github/scripts/money-gate-inputs-changed.sh',
    '.github/workflows/ci.yml',
  ])('runs when %s changes', (file) => {
    expect(decide('7', 'true', `docs/x.md\n${file}`)).toBe('true')
  })

  it('runs when any file of the harness or its fixtures changes, enumerated from disk', () => {
    const files = filesUnder(join(workerRoot, 'money-gate'))
    expect(files.length).toBeGreaterThan(10)
    for (const f of files) expect({ f, decision: decide('7', 'true', f) }).toEqual({ f, decision: 'true' })
  })

  it('runs when any workspace package the Worker depends on changes, derived from its package.json', () => {
    const pkg = JSON.parse(readFileSync(join(workerRoot, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    const workspaceDeps = Object.entries(pkg.dependencies).filter(([, v]) => v.startsWith('workspace:')).map(([k]) => k)
    expect(workspaceDeps.length).toBeGreaterThanOrEqual(3)
    for (const dir of readdirSync(join(repoRoot, 'packages'))) {
      const manifest = JSON.parse(readFileSync(join(repoRoot, 'packages', dir, 'package.json'), 'utf8')) as { name: string }
      if (!workspaceDeps.includes(manifest.name)) continue
      expect({ dir, decision: decide('7', 'true', `packages/${dir}/src/index.ts`) }).toEqual({ dir, decision: 'true' })
    }
  })

  it('matches whole path segments, so a look alike path does not wake it', () => {
    expect(decide('7', 'true', 'docs/apps/worker/src/notes.md')).toBe('false')
    expect(decide('7', 'true', 'apps/worker-tail/wrangler.toml')).toBe('false')
  })

  it('fails closed: a failed lookup, an empty list or missing arguments run the gate', () => {
    expect(decide('7', 'false', '')).toBe('true')
    expect(decide('7', 'true', '')).toBe('true')
    expect(decide('7')).toBe('true')
    expect(decide('', 'true', 'docs/x.md')).toBe('true')
  })
})
