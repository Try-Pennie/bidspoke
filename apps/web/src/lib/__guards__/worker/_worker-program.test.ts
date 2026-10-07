import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { WEB_SRC, WORKER_SRC, listFiles } from '../../__tests__/_scan-utils'
import { buildWorkerProgram, workerProgramLoadErrors } from './_worker-program'

/**
 * The one way a guard builds a TypeScript program over the worker's source.
 *
 * Two guards each built their own, and both gave TypeScript the worker's
 * tsconfig without its path, so `types: ["@cloudflare/workers-types"]` was
 * resolved from apps/web, where the package is not installed. Every Request
 * and URL in those programs was then `any`, and a rule keyed on either type
 * silently matched nothing.
 *
 * Built once, while the suite is collected: loading the Workers types is the
 * slow part.
 */
const OPS_ENTRY = path.join(WORKER_SRC, 'ops/index.ts')
const program = buildWorkerProgram([OPS_ENTRY])
const PLANTED = path.join(WORKER_SRC, 'routes/__planted_program__.ts')
const withExtra = buildWorkerProgram([OPS_ENTRY], { [PLANTED]: 'export const x: Request | null = null\n' })

describe('buildWorkerProgram', () => {
  it('loads the worker program with no configuration or global errors', () => {
    expect(workerProgramLoadErrors(program)).toEqual([])
  })

  it('resolves the Workers globals to real types, not any', () => {
    const checker = program.getTypeChecker()
    const sf = program.getSourceFile(OPS_ENTRY)
    expect(sf).toBeDefined()
    for (const name of ['Request', 'URL', 'Response']) {
      const symbol = checker.resolveName(name, sf as ts.SourceFile, ts.SymbolFlags.Type, false)
      expect(symbol, name).toBeDefined()
      const type = checker.getDeclaredTypeOfSymbol(symbol as ts.Symbol)
      expect(type.flags & ts.TypeFlags.Any, `${name} resolved to any`).toBe(0)
      // From the Workers package itself: the worker's lib is ES2022 alone, and
      // a browser lib added later would declare these too, from elsewhere.
      const from = (symbol as ts.Symbol).declarations?.map((d) => d.getSourceFile().fileName) ?? []
      expect(from.some((f) => f.includes('@cloudflare/workers-types')), `${name} declared in ${from.join(', ')}`).toBe(true)
    }
  })

  it('serves an extra in-memory file on top of the disk', () => {
    expect(withExtra.getSourceFile(PLANTED)?.text).toContain('Request')
    expect(workerProgramLoadErrors(withExtra)).toEqual([])
  })
})

describe('no test builds a program from the worker config by hand', () => {
  it('leaves parseJsonConfigFileContent and createProgram to this helper alone', () => {
    const helper = path.join(WEB_SRC, 'lib/__guards__/worker/_worker-program.ts')
    const offenders = listFiles(WEB_SRC, { exts: ['.ts', '.tsx'], skipDirs: ['node_modules'], includeTests: true })
      .filter((file) => file !== helper && file !== fileURLToPath(import.meta.url))
      .filter((file) => /\bparseJsonConfigFileContent\b|\bcreateProgram\(/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(WEB_SRC, file))
    expect(offenders).toEqual([])
  })
})
