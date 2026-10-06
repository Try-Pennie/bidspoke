/**
 * Only engine/run-reality.ts reads what kind of run this is (#1708, plan 0.D).
 *
 * The test flag, the shadow mode and LOCAL_DEV used to be read by eight engine
 * call sites, each drawing its own conclusion. They now all ask run-reality.ts,
 * and this scan fails on a direct read anywhere else in the engine, so a new
 * node cannot quietly decide for itself again (L621, L613).
 *
 * Out of scope on purpose: lib/local-dev-write-guard.ts (behind lib/supabase.ts
 * and ops/ops-db.ts) and lib/salesforce-write.ts read LOCAL_DEV to refuse writes
 * to production from a laptop. That is a guard on
 * the client, true of every caller whatever the run, not a conclusion about a
 * run, and they sit outside the engine.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { listTsFiles, sanitizeSource, WORKER_SRC } from '../../__tests__/_scan-utils'

const ENGINE = path.join(WORKER_SRC, 'engine')
const MODULE = path.join(ENGINE, 'run-reality.ts')

const FORBIDDEN: { what: string; re: RegExp }[] = [
  { what: 'the test flag on a context', re: /\bctx\.isTest\b/ },
  { what: 'the test flag on run options', re: /\boptions\.isTest\b/ },
  { what: 'the shadow mode', re: /\.shadow_mode\b/ },
  { what: 'the shadow mode on run options', re: /\boptions\.shadowMode\b/ },
  { what: 'LOCAL_DEV', re: /\.LOCAL_DEV\b/ },
  { what: 'the retired shadow helpers', re: /\bisShadow(DryRun|StandIn)\b/ },
]

function offenders(file: string): string[] {
  const lines = sanitizeSource(readFileSync(file, 'utf8')).split('\n')
  const out: string[] = []
  lines.forEach((line, i) => {
    for (const f of FORBIDDEN) if (f.re.test(line)) out.push(`${path.relative(WORKER_SRC, file)}:${i + 1} reads ${f.what}`)
  })
  return out
}

describe('run reality has one reader in the engine', () => {
  it('finds the engine files and the module, so the scan cannot pass on nothing', () => {
    const files = listTsFiles(ENGINE)
    expect(files.length).toBeGreaterThan(20)
    expect(files).toContain(MODULE)
  })

  it('every pattern matches the read it names (positive control)', () => {
    const samples = ['if (ctx.isTest) x()', 'options.isTest ?? false', 'ctx.shadow_mode === 1', 'if (options.shadowMode) y', 'env.LOCAL_DEV', 'isShadowDryRun(ctx)']
    samples.forEach((s, i) => expect(FORBIDDEN[i].re.test(s), s).toBe(true))
  })

  it('no engine file but run-reality.ts reads the test flag, the shadow mode or LOCAL_DEV', () => {
    const found = listTsFiles(ENGINE).filter((f) => f !== MODULE).flatMap(offenders)
    expect(found).toEqual([])
  })
})
