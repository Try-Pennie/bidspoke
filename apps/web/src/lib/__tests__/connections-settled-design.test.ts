/**
 * Guard (#2338): the settled Connections designs carry one check for every decision their map
 * says is verified by a check, on exactly the frames the map names.
 *
 * The build of #2338 is done only when it scores 100% against docs/design/connections-page.html
 * and docs/design/connections-step-form.html, and the score counts the decision map, not the
 * checks: a decision whose check is missing reads UNCHECKED and is never met, and a check run on
 * fewer frames than its decision names passes a build that is wrong on the others. So the map and
 * each `<name>.checks.js` beside it are compared here, and the regeneration sources the files are
 * written from (docs/design/<name>/settled.json) must name the committed fixture.
 *
 * Has a positive control (L1): a map with a decision its checks file lacks, and a check on the
 * wrong frames, are both refused by the same comparison.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

type Decision = { id: string; verify?: string; frames?: string[]; requirement?: string; noCode?: string }
type Check = { id: string; frames: string[] }

const DESIGNS = ['connections-page', 'connections-step-form']
const design = (name: string) => path.join(REPO_ROOT, 'docs/design', name)

function jsonBlock(html: string, id: string): unknown {
  const m = new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`).exec(html)
  if (!m) throw new Error(`no ${id} block`)
  return JSON.parse(m[1])
}

function loadChecks(source: string): Check[] {
  const sandbox: { window: { DESIGN_CHECKS?: Check[] } } = { window: {} }
  vm.runInNewContext(source, sandbox)
  return sandbox.window.DESIGN_CHECKS ?? []
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

describe('settled Connections designs (#2338)', () => {
  for (const name of DESIGNS) {
    const html = readFileSync(design(`${name}.html`), 'utf8')
    const decisions = (jsonBlock(html, 'decision-map') as { decisions: Decision[] }).decisions
    const frameIds = (jsonBlock(html, 'design-frames') as { frames: { id: string }[] }).frames.map((f) => f.id)
    const checks = loadChecks(readFileSync(design(`${name}.checks.js`), 'utf8'))

    it(`${name}: every checked decision has its check, on every frame it shows on`, () => {
      expect(checks.length).toBeGreaterThan(0)
      expect(coverageProblems(decisions, checks, frameIds)).toEqual([])
    })

    it(`${name}: every decision has exactly one owner`, () => {
      const unowned = decisions.filter((d) => !d.requirement === !d.noCode).map((d) => d.id)
      expect(unowned).toEqual([])
    })

    it(`${name}: its regeneration spec draws from the committed fixture`, () => {
      const spec = JSON.parse(readFileSync(design(`${name}/settled.json`), 'utf8')) as { fixture: string; frames: { id: string }[] }
      expect(path.resolve(design(name), spec.fixture)).toBe(design(`${name}.fixture.json`))
      expect(spec.frames.map((f) => f.id)).toEqual(frameIds)
    })
  }

  // Rounds 24 to 26 (Dan, 2026-10-20). A check reads the design through the browser, so it cannot
  // run here; what can drift silently is the builder and its check each holding their own copy of a
  // decision's words or size, so the pair is read back from both and compared.
  describe('rounds 24 to 26: each builder draws what its check expects', () => {
    const read = (rel: string) => readFileSync(design(rel), 'utf8')

    it('D8: the step form problem line reads "<status> on the Connections page", the page a dark underlined link', () => {
      const checks = read('connections-step-form.checks.js')
      const words = /var WHERE = "([^"]+)", PAGE = "([^"]+)"/.exec(checks)
      expect(words?.slice(1)).toEqual([' on the ', 'Connections page'])
      const builder = read('connections-step-form/builder.js')
      expect(builder).toContain(`" on the "`)
      expect(builder).toContain(`el("a", null, "Connections page")`)
      const link = /\.sf-problem a \{([^}]*)\}/.exec(read('connections-step-form/screen.css'))?.[1] ?? ''
      expect(link).toContain('color: #1D212F')
      expect(link).toContain('text-decoration: underline')
      expect(link).toContain('font-weight: 400')
    })

    it('D19 to D21: the dialog title is drawn at the size the checks require, 20px', () => {
      const size = /var DIALOG_TITLE = "(\d+px)"/.exec(read('connections-page.checks.js'))?.[1]
      expect(size).toBe('20px')
      const drawn = /\.cx-dialog h2 \{[^}]*font-size: (\d+px)/.exec(read('connections-page/screen.css'))?.[1]
      expect(drawn).toBe(size)
    })

    it('D15: the new org frame is drawn from the fixture its check reads, and every all frame check covers it', () => {
      const fixture = JSON.parse(read('connections-page.fixture.json')) as { draft: { newOrg?: { name: string; address: string } } }
      expect(fixture.draft.newOrg).toEqual({ name: 'Lendco Salesforce', address: 'lendco.my.salesforce.com' })
      const spec = JSON.parse(read('connections-page/settled.json')) as { frames: { id: string; variant: Record<string, unknown> }[] }
      expect(spec.frames.find((f) => f.id === 'add-salesforce-new-org')?.variant).toEqual({ state: 'add', service: 'Salesforce', save: 'ready', org: 'new' })
      const map = (jsonBlock(read('connections-page.html'), 'decision-map') as { decisions: Decision[] }).decisions
      const covering = map.filter((d) => d.frames?.includes('add-salesforce-new-org')).map((d) => d.id)
      // D28 (round 27, 2026-10-21): the frame's open menu is the one drawing a highlighted row.
      expect(covering).toEqual(['D15', 'D24', 'D25', 'D27', 'D28'])
    })
  })

  it('refuses a missing check and a check on the wrong frames (positive control)', () => {
    const decisions: Decision[] = [
      { id: 'D1', frames: ['a', 'b'], requirement: 'R1' },
      { id: 'D2', frames: ['a'], requirement: 'R2' },
      { id: 'D3', verify: 'picture', noCode: 'looked at' },
    ]
    expect(coverageProblems(decisions, [{ id: 'D1', frames: ['a'] }], ['a', 'b'])).toEqual([
      'D1 is checked on a but shows on a, b',
      'D2 has no check',
    ])
    expect(coverageProblems(decisions, [{ id: 'D1', frames: ['a', 'b'] }, { id: 'D2', frames: ['a'] }], ['a', 'b'])).toEqual([])
  })
})
