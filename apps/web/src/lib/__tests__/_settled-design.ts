/**
 * Reading a settled design file (docs/design/<name>.html) and the checks beside it, for the guards
 * that hold each settled design's decision map and its checks together (#2338, #2590).
 *
 * The build of a settled design is done only when it scores 100% against the file, and the score
 * counts the decision map, not the checks: a decision whose check is missing reads UNCHECKED and is
 * never met, and a check run on fewer frames than its decision names passes a build that is wrong on
 * the others. coverageProblems names every such gap.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { REPO_ROOT } from './_scan-utils'

export type Decision = { id: string; verify?: string; frames?: string[]; requirement?: string; noCode?: string }
export type Check = { id: string; frames: string[] }

export const designPath = (name: string) => path.join(REPO_ROOT, 'docs/design', name)

export function jsonBlock(html: string, id: string): unknown {
  const m = new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`).exec(html)
  if (!m) throw new Error(`no ${id} block`)
  return JSON.parse(m[1])
}

export function loadChecks(source: string): Check[] {
  const sandbox: { window: { DESIGN_CHECKS?: Check[] } } = { window: {} }
  vm.runInNewContext(source, sandbox)
  return sandbox.window.DESIGN_CHECKS ?? []
}

/** A settled design's decisions, frame ids and checks, read from the committed files. */
export function readSettledDesign(name: string): { decisions: Decision[]; frameIds: string[]; checks: Check[] } {
  const html = readFileSync(designPath(`${name}.html`), 'utf8')
  return {
    decisions: (jsonBlock(html, 'decision-map') as { decisions: Decision[] }).decisions,
    frameIds: (jsonBlock(html, 'design-frames') as { frames: { id: string }[] }).frames.map((f) => f.id),
    checks: loadChecks(readFileSync(designPath(`${name}.checks.js`), 'utf8')),
  }
}

/** Every way the checks fail to cover the map, each said by decision id. */
export function coverageProblems(decisions: Decision[], checks: Check[], frameIds: string[]): string[] {
  const problems: string[] = []
  const byId = new Map(checks.map((c) => [c.id, c]))
  for (const d of decisions) {
    if ((d.verify ?? 'check') !== 'check') continue
    const c = byId.get(d.id)
    if (!c) { problems.push(`${d.id} has no check`); continue }
    const want = [...(d.frames ?? [])].sort()
    const got = [...c.frames].sort()
    if (JSON.stringify(want) !== JSON.stringify(got)) problems.push(`${d.id} is checked on ${got.join(', ')} but shows on ${want.join(', ')}`)
  }
  const mapped = new Set(decisions.map((d) => d.id))
  for (const c of checks) {
    if (!mapped.has(c.id)) problems.push(`${c.id} is checked but is no decision`)
    for (const f of c.frames) if (!frameIds.includes(f)) problems.push(`${c.id} names frame ${f}, which the design does not hold`)
  }
  if (checks.length !== byId.size) problems.push('two checks share an id')
  return problems
}
