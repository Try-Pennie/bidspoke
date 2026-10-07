/**
 * Every ops database query goes through readOpsRows (#1709, plan 0.E, L18).
 *
 * The ops Worker reaches the ops database as service_role, which bypasses RLS,
 * so the only thing keeping one organization's ops rows from another is that
 * every read filters on organization_id. readOpsRows in apps/worker/src/ops/
 * ops-db.ts does that, by type and at run time. This scan fails on any other
 * query against the ops client:
 *
 *  1. `.from`, `.rpc` or `.schema` on the ops client, by property access, by
 *     element access or by destructuring, anywhere but inside readOpsRows;
 *  2. the ops client handed to anything typed wider than OpsSupabaseClient (a
 *     plain SupabaseClient parameter, a generic, an `as` cast, a wider return
 *     type), because past that point its type no longer says it is the ops
 *     client and rule 1 cannot follow it.
 *
 * It asks the TypeScript checker for each receiver's TYPE rather than matching
 * a variable name, so an alias, a parameter or a property holding the client is
 * caught the same as the variable the factory returned. The ops client is told
 * from the bidding one by its brand (OpsSupabaseClient).
 *
 * Seen red on 2026-10-06 against a planted file (the last test here, kept so the
 * check stays proven) and against a real `.from(` added to src/ops/index.ts.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { WORKER_SRC, listTsFiles } from '../../__tests__/_scan-utils'
import { buildWorkerProgram, workerProgramLoadErrors } from './_worker-program'

const OPS_DB = path.join(WORKER_SRC, 'ops/ops-db.ts')
const HELPER = 'readOpsRows'
const QUERY_METHODS = new Set(['from', 'rpc', 'schema'])

const rel = (file: string) => path.relative(WORKER_SRC, file).replace(/\\/g, '/')

/** Whether a type is (or, for a union, may be) the branded ops client. */
function isOpsClient(checker: ts.TypeChecker, type: ts.Type): boolean {
  const parts = type.isUnion() ? type.types : [type]
  return parts.some((t) => checker.getPropertiesOfType(t).some((p) => /^__@OPS_CLIENT@\d+$/.test(String(p.escapedName))))
}

interface Finding {
  file: string
  line: number
  what: string
}

/** The span of readOpsRows's body in ops-db.ts, the one place a query is allowed. */
function helperBody(sf: ts.SourceFile): [number, number] | null {
  let span: [number, number] | null = null
  sf.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === HELPER && node.body) span = [node.body.getStart(sf), node.body.getEnd()]
  })
  return span
}

export function scanOpsQueries(program: ts.Program, files: string[]): { offenders: Finding[]; allowed: Finding[] } {
  const checker = program.getTypeChecker()
  const offenders: Finding[] = []
  const allowed: Finding[] = []
  for (const file of files) {
    const sf = program.getSourceFile(file)
    if (!sf) throw new Error(`${rel(file)} is not in the program, so it was not scanned`)
    const body = file === OPS_DB ? helperBody(sf) : null
    const at = (node: ts.Node, what: string) => {
      const finding = { file: rel(file), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, what }
      const inHelper = body !== null && node.getStart(sf) >= body[0] && node.getEnd() <= body[1]
      ;(inHelper ? allowed : offenders).push(finding)
    }
    const opsTyped = (node: ts.Node) => isOpsClient(checker, checker.getTypeAtLocation(node))

    const visit = (node: ts.Node) => {
      // Rule 1: a query method reached on the ops client.
      if (ts.isPropertyAccessExpression(node) && QUERY_METHODS.has(node.name.text) && opsTyped(node.expression)) {
        at(node, `.${node.name.text} on the ops client`)
      } else if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        QUERY_METHODS.has(node.argumentExpression.text) &&
        opsTyped(node.expression)
      ) {
        at(node, `['${node.argumentExpression.text}'] on the ops client`)
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name
        const name = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null
        const source = node.parent.parent
        const holder = ts.isVariableDeclaration(source) ? source.initializer : ts.isParameter(source) ? source.name : undefined
        if (name && QUERY_METHODS.has(name) && holder && opsTyped(holder)) at(node, `${name} destructured off the ops client`)
      }

      // Rule 2: the ops client handed somewhere its type no longer says what it is.
      // A destructuring initializer is rule 1's to judge: its contextual type is
      // only the pattern's own shape.
      const parent = node.parent as ts.Node | undefined
      const destructured = parent !== undefined && ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isObjectBindingPattern(parent.name)
      if (parent && ts.isExpression(node) && !ts.isPropertyAccessExpression(parent) && !destructured && opsTyped(node)) {
        const contextual = checker.getContextualType(node)
        if (contextual && !isOpsClient(checker, contextual)) {
          at(node, `the ops client handed to ${checker.typeToString(contextual)}, where this scan cannot follow it`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return { offenders, allowed }
}

const SOURCE_FILES = listTsFiles(WORKER_SRC)
const fmt = (f: Finding) => `${f.file}:${f.line} ${f.what}`

describe('every ops database query goes through readOpsRows (#1709)', () => {
  const program = buildWorkerProgram(SOURCE_FILES)
  const result = scanOpsQueries(program, SOURCE_FILES)

  it('loads the worker program fully, so a clean result is not every type being any', () => {
    expect(workerProgramLoadErrors(program)).toEqual([])
  })

  it('scans the worker source, the ops client module among it', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(100)
    expect(SOURCE_FILES).toContain(OPS_DB)
    expect(readFileSync(OPS_DB, 'utf8')).toMatch(new RegExp(`export async function ${HELPER}\\b`))
  })

  it('sees the helper\'s own query on the ops client, so a clean result is a measurement (L1)', () => {
    expect(result.allowed.map(fmt)).toEqual([expect.stringMatching(/^ops\/ops-db\.ts:\d+ \.from on the ops client$/)])
  })

  it('finds no other query against the ops client, and no widening of it', () => {
    expect(result.offenders.map(fmt)).toEqual([])
  })

  it('fails on each planted way round the helper, by file, line and kind', () => {
    const planted = path.join(WORKER_SRC, 'ops/__planted_ops_query__.ts')
    const src = [
      "import type { SupabaseClient } from '@supabase/supabase-js'",
      "import { createOpsSupabaseClient, type OpsDbEnv, type OpsSupabaseClient } from './ops-db'",
      'function wider(c: SupabaseClient) { return c }',
      'export function planted(env: OpsDbEnv, held: { db: OpsSupabaseClient }) {',
      '  const db = createOpsSupabaseClient(env)',
      "  void db.from('ops_runs').select('*')",
      '  const alias = db',
      "  void alias.rpc('anything')",
      "  void held.db['schema']('other')",
      '  const { from } = db',
      '  void from',
      '  wider(db)',
      '  return db as SupabaseClient',
      '}',
    ].join('\n')
    const program = buildWorkerProgram([OPS_DB], { [planted]: src })
    const { offenders } = scanOpsQueries(program, [planted])
    expect(offenders.map(fmt)).toEqual([
      'ops/__planted_ops_query__.ts:6 .from on the ops client',
      'ops/__planted_ops_query__.ts:8 .rpc on the ops client',
      "ops/__planted_ops_query__.ts:9 ['schema'] on the ops client",
      'ops/__planted_ops_query__.ts:10 from destructured off the ops client',
      expect.stringMatching(/^ops\/__planted_ops_query__\.ts:12 the ops client handed to SupabaseClient<.*where this scan cannot follow it$/),
      expect.stringMatching(/^ops\/__planted_ops_query__\.ts:13 the ops client handed to SupabaseClient<.*where this scan cannot follow it$/),
    ])
  })
})
