/**
 * The runbook lists every kind of ops tick problem under the rule it pages by
 * (#2506): docs/reference/observability.md, read by whoever is paged with "The
 * ops minute cron reported a problem". It is a second copy of
 * OPS_TICK_PROBLEM_RULES, so it is held to the code here, kind for kind (L679):
 * a kind added, removed or moved in one place only fails this.
 *
 * It reads worker source, so it lives here rather than in the worker's own tests.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WORKER_SRC } from '../../__tests__/_scan-utils'

const SOURCE = readFileSync(path.join(WORKER_SRC, 'lib/ops-gateway-contract.ts'), 'utf8')
const DOC = readFileSync(path.join(REPO_ROOT, 'docs/reference/observability.md'), 'utf8')

/** Each kind in the rules table, by the rule it is listed with. */
function rulesInCode(): Record<string, string[]> {
  const start = SOURCE.indexOf('export const OPS_TICK_PROBLEM_RULES = {')
  const end = SOURCE.indexOf('} as const satisfies', start)
  expect(start, 'OPS_TICK_PROBLEM_RULES is no longer a const object in ops-gateway-contract.ts').toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const byRule: Record<string, string[]> = { three_in_a_row: [], at_once: [] }
  for (const m of SOURCE.slice(start, end).matchAll(/^\s+([a-z_]+): '(three_in_a_row|at_once)',$/gm)) byRule[m[2]].push(m[1])
  return byRule
}

/** The kinds the runbook's rows list, by the words each row starts with. */
function kindsInDoc(rowStart: string): string[] {
  return DOC.split('\n')
    .filter((line) => line.startsWith(rowStart))
    .flatMap((line) => [...line.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]))
}

describe('the ops tick problem rules are documented as the code applies them', () => {
  it('reads a table of both rules from the code', () => {
    const rules = rulesInCode()
    expect(rules.three_in_a_row.length).toBeGreaterThan(5)
    expect(rules.at_once.length).toBeGreaterThan(5)
  })

  it('lists every kind held for three ticks in a row, and no other', () => {
    expect(kindsInDoc('| Three ticks in a row |').sort()).toEqual(rulesInCode().three_in_a_row.sort())
  })

  // The row for the bidding Worker's own kinds also names start_stamp, the key
  // an older release's lone missed stamp is held under, which is not at once.
  it('lists every kind paged at once, and no other', () => {
    expect(kindsInDoc('| At once').filter((k) => k !== 'start_stamp').sort()).toEqual(rulesInCode().at_once.sort())
  })

  // #2340: the kinds judged by their sweep's runs rather than the tick's, which
  // the person paged needs to read three in a row as three runs of the sweep.
  it('lists every kind judged by its sweep\'s runs, and no other', () => {
    const start = SOURCE.indexOf('export const OPS_TICK_PROBLEM_SWEEPS = {')
    const end = SOURCE.indexOf('} as const satisfies', start)
    expect(start, 'OPS_TICK_PROBLEM_SWEEPS is no longer a const object in ops-gateway-contract.ts').toBeGreaterThan(-1)
    const inCode = [...SOURCE.slice(start, end).matchAll(/^\s+([a-z_]+): '[a-z_]+',$/gm)].map((m) => m[1])
    expect(inCode.length).toBeGreaterThan(0)
    expect(kindsInDoc('Kinds judged by their sweep\'s runs').sort()).toEqual(inCode.sort())
  })
})
