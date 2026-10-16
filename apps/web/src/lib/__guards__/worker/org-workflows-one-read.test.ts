/**
 * An organization's workflow definitions are read in one place (#2142, L613):
 * readOrgWorkflows in apps/worker/src/lib/org-workflows.ts, which scopes the
 * read to the organization and to workflows not soft deleted, pages past the
 * 1,000 row cap, and drops a row the scoping let through. The Worker is
 * service_role, so that read IS the scoping.
 *
 * Before it, the buyer profile route, the step rename impact route, the code
 * worker migration and the timeout audit each wrote their own copy of
 * `.from('workflows').select('... definition').eq('organization_id', ...)
 * .is('deleted_at', null)`, none of them paged. This scan fails on the next
 * hand written copy: a query chain on `workflows` that filters by
 * organization_id and selects `definition` (or `*`), anywhere but org-workflows.ts.
 * A read of one workflow by id is not this question and is allowed.
 *
 * Seen red on 2026-10-15 against the tree before the conversion (six copies:
 * buyer-profiles.ts twice, workflows.ts, admin.ts, timeout-audit.ts twice) and
 * against the planted chain in the last test.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { WORKER_SRC, listTsFiles } from '../../__tests__/_scan-utils'

const HOME = 'lib/org-workflows.ts'

const rel = (file: string) => path.relative(WORKER_SRC, file).replace(/\\/g, '/')

/** The method calls of a chain starting at `.from('workflows')`, outermost first. */
function chainCalls(start: ts.CallExpression): Array<{ name: string; args: readonly ts.Expression[] }> {
  const calls: Array<{ name: string; args: readonly ts.Expression[] }> = []
  let node: ts.Node = start
  while (ts.isPropertyAccessExpression(node.parent) && ts.isCallExpression(node.parent.parent) && node.parent.parent.expression === node.parent) {
    calls.push({ name: node.parent.name.text, args: node.parent.parent.arguments })
    node = node.parent.parent
  }
  return calls
}

const literal = (e: ts.Expression | undefined): string | null => (e && ts.isStringLiteralLike(e) ? e.text : null)

export function scanOrgWorkflowReads(file: string, source: string): Array<{ file: string; line: number }> {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const found: Array<{ file: string; line: number }> = []
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'from' &&
      literal(node.arguments[0]) === 'workflows'
    ) {
      const calls = chainCalls(node)
      const select = calls.find((c) => c.name === 'select')
      const columns = literal(select?.args[0]) ?? ''
      const readsDefinitions = /\bdefinition\b|\*/.test(columns)
      const byOrganization = calls.some((c) => c.name === 'eq' && literal(c.args[0]) === 'organization_id')
      const oneWorkflow = calls.some((c) => (c.name === 'eq' || c.name === 'in') && literal(c.args[0]) === 'id')
      if (readsDefinitions && byOrganization && !oneWorkflow) {
        found.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

describe('organization workflow definitions are read through readOrgWorkflows', () => {
  const files = listTsFiles(WORKER_SRC)

  it('scanned the Worker source (a positive control: the one allowed read is found)', () => {
    const home = files.find((f) => rel(f) === HOME)
    expect(home).toBeDefined()
    expect(scanOrgWorkflowReads(HOME, readFileSync(home as string, 'utf8'))).toHaveLength(1)
  })

  it('no other file reads them', () => {
    const offenders = files
      .filter((f) => rel(f) !== HOME)
      .flatMap((f) => scanOrgWorkflowReads(rel(f), readFileSync(f, 'utf8')))
      .map((o) => `${o.file}:${o.line}`)
    expect(offenders).toEqual([])
  })

  it('catches a planted copy, and allows a read of one workflow by id', () => {
    const planted = `
      const { data } = await supabase.from('workflows').select('id, name, definition').eq('organization_id', orgId).is('deleted_at', null)
      const one = await supabase.from('workflows').select('id, definition').eq('id', id).eq('organization_id', orgId).single()
      const names = await supabase.from('workflows').select('id, name').eq('organization_id', orgId)
    `
    expect(scanOrgWorkflowReads('planted.ts', planted).map((o) => o.line)).toEqual([2])
  })
})
