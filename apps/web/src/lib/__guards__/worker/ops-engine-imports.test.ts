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

/**
 * A module's engine imports, resolved against WORKER_SRC: every relative
 * specifier in either quote after `from` (an import or a re-export), a bare
 * side effect `import`, a dynamic `import(` or a `require(`.
 */
function engineImportsOf(file: string, src: string): string[] {
  const found: string[] = []
  for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])(\.[^'"]+)\1/g)) {
    const target = path.relative(WORKER_SRC, path.resolve(path.dirname(file), m[2])).replace(/\\/g, '/')
    if (target === 'engine' || target.startsWith('engine/')) found.push(target)
  }
  return found
}

/** Every engine import of each non test ops module. */
function engineImports(files: readonly string[]): Array<{ file: string; target: string }> {
  return files.flatMap((file) => engineImportsOf(file, readFileSync(file, 'utf8')).map((target) => ({ file: path.relative(WORKER_SRC, file), target })))
}

const opsModules = () => listTsFiles(OPS).filter((f) => !f.includes(`${path.sep}__tests__${path.sep}`) && !f.endsWith('.test.ts'))

describe('ops modules reach the engine only through its pure parts', () => {
  it('finds the run walk\'s engine imports, so the check is not vacuous (L98)', () => {
    expect(engineImports(opsModules()).some((i) => i.file === 'ops/run-walk.ts' && i.target === 'engine/graph')).toBe(true)
  })

  it('imports no engine module outside the allowed list', () => {
    expect(engineImports(opsModules()).filter((i) => !ALLOWED_ENGINE_IMPORTS.has(i.target))).toEqual([])
  })

  it('sees the money walk and the node registry however they are imported (seen red)', () => {
    const planted = path.join(OPS, 'planted.ts')
    const refused = (src: string) => engineImportsOf(planted, src).filter((t) => !ALLOWED_ENGINE_IMPORTS.has(t))
    expect(refused("import { executeWorkflow } from '../engine/index'")).toEqual(['engine/index'])
    expect(refused('import { executeNode } from "../engine/nodes/index"')).toEqual(['engine/nodes/index'])
    expect(refused("import '../engine/nodes/partner-bid'")).toEqual(['engine/nodes/partner-bid'])
    expect(refused("const m = await import('../engine')")).toEqual(['engine'])
    expect(refused("const r = require('../engine/nodes/index')")).toEqual(['engine/nodes/index'])
    expect(refused("export { executeWorkflow } from '../engine/index'")).toEqual(['engine/index'])
    expect(refused("import { executeFilterNode } from '../engine/nodes/filter'")).toEqual([])
    expect(refused("import { formatErr } from '../lib/format-error'")).toEqual([])
  })
})
