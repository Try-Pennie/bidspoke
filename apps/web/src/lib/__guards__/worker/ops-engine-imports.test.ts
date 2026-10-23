/**
 * The ops Worker reaches the money engine only through its pure parts (#1950).
 *
 * The ops run body (apps/worker/src/ops/run-walk.ts) reuses the engine's graph
 * helpers, its context builder and the in memory executors of the shared node
 * types (filter, branch, transform, response), which reach nothing outside the
 * Worker. It must never import the money walk (engine/index.ts) or the node
 * registry (engine/nodes/index.ts), which carries every money executor, and no
 * other ops module should reach the engine at all: an ops step that leaves the
 * Worker does so through a handler and ctx.send, never an engine executor that
 * makes its own fetch (#1725, the lane rule). This scan fails on any other
 * engine import from a non test module under src/ops.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listTsFiles, WORKER_SRC } from '../../__tests__/_scan-utils'

const OPS = path.join(WORKER_SRC, 'ops')

/** The engine modules an ops module may import, each pure. */
const ALLOWED_ENGINE_IMPORTS = new Set([
  'engine/context', 'engine/graph', 'engine/nodes/branch', 'engine/nodes/filter', 'engine/nodes/response', 'engine/nodes/transform',
])

/** Every engine import of each non test ops module, resolved against WORKER_SRC. */
function engineImports(files: readonly string[]): Array<{ file: string; target: string }> {
  const found: Array<{ file: string; target: string }> = []
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/from\s+'(\.[^']+)'|import\(\s*'(\.[^']+)'\s*\)/g)) {
      const spec = m[1] ?? m[2]
      const target = path.relative(WORKER_SRC, path.resolve(path.dirname(file), spec)).replace(/\\/g, '/')
      if (target === 'engine' || target.startsWith('engine/')) found.push({ file: path.relative(WORKER_SRC, file), target })
    }
  }
  return found
}

const opsModules = () => listTsFiles(OPS).filter((f) => !f.includes(`${path.sep}__tests__${path.sep}`) && !f.endsWith('.test.ts'))

describe('ops modules reach the engine only through its pure parts', () => {
  it('finds the run walk\'s engine imports, so the check is not vacuous (L98)', () => {
    expect(engineImports(opsModules()).some((i) => i.file === 'ops/run-walk.ts' && i.target === 'engine/graph')).toBe(true)
  })

  it('imports no engine module outside the allowed list', () => {
    expect(engineImports(opsModules()).filter((i) => !ALLOWED_ENGINE_IMPORTS.has(i.target))).toEqual([])
  })

  it('sees the money walk and the node registry when they are imported (seen red)', () => {
    const planted = path.join(OPS, 'planted.ts')
    const scan = (src: string) => {
      const out: string[] = []
      for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
        const target = path.relative(WORKER_SRC, path.resolve(path.dirname(planted), m[1])).replace(/\\/g, '/')
        if (target.startsWith('engine') && !ALLOWED_ENGINE_IMPORTS.has(target)) out.push(target)
      }
      return out
    }
    expect(scan("import { executeWorkflow } from '../engine/index'")).toEqual(['engine/index'])
    expect(scan("import { executeNode } from '../engine/nodes/index'")).toEqual(['engine/nodes/index'])
    expect(scan("import { executePartnerBidNode } from '../engine/nodes/partner-bid'")).toEqual(['engine/nodes/partner-bid'])
    expect(scan("import { executeFilterNode } from '../engine/nodes/filter'")).toEqual([])
  })
})
