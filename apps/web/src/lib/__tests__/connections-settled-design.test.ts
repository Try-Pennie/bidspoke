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
import { describe, expect, it } from 'vitest'
import { coverageProblems, designPath as design, jsonBlock, loadChecks, readSettledDesign, type Decision } from './_settled-design'
import { COMPANY_MAILBOX_FIX } from '@/components/connections/connection-model'
import { CONNECTION_REPLACE_MOST } from '@/lib/api'
import { replaceCapSentence } from '@/components/connections/ConnectionDialogs'

const DESIGNS = ['connections-page', 'connections-step-form']

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

  // Rounds 24 to 27 (Dan, 2026-10-20 and 21). A check reads the design through the browser, so it cannot
  // run here; what can drift silently is the builder and its check each holding their own copy of a
  // decision's words or size, so the pair is read back from both and compared.
  describe('rounds 24 to 27: each builder draws what its check expects', () => {
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

    // The Worker's own test (connection-create-refusals.test.ts) holds it to the same words.
    it("D34: the no-cap frame and its check hold round 33's sentence, word for word", () => {
      const before = 'Bidspoke has no limit set yet on how many Salesforce calls its workflows may make to '
      const after = ', so it cannot connect to that org. Nothing was saved. Ask Dan to set a limit for this org, then save again.'
      expect(read('connections-page/builder.js')).toContain(`${before}" + address + "${after}`)
      expect(read('connections-page.checks.js')).toContain(`${before}" + org + "${after}`)
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
      // D35 (round 34, 2026-10-21): that menu sits over the fields below it.
      expect(covering).toEqual(['D15', 'D24', 'D25', 'D27', 'D28', 'D35'])
    })
  })

  // #2904 (Dan, 2026-10-27): the Replace cap is drawn as shipped, so the frames and their checks must hold
  // the page's own words and number, never a copy that drifts from ConnectionDialogs.tsx.
  describe('#2904: the Replace cap frames hold the page\'s own sentences', () => {
    const read = (rel: string) => readFileSync(design(rel), 'utf8')

    it('D45 and D46: each check expects the sentence replaceCapSentence gives for 9 workflows', () => {
      const checks = read('connections-page.checks.js')
      expect(checks).toContain(`cappedProblem(doc, ctx, ${CONNECTION_REPLACE_MOST}, "${replaceCapSentence(9, CONNECTION_REPLACE_MOST)}", false)`)
      expect(checks).toContain(`cappedProblem(doc, ctx, ${CONNECTION_REPLACE_MOST + 1}, "${replaceCapSentence(9, CONNECTION_REPLACE_MOST + 1)}", true)`)
    })

    it('the builder draws the cap at the page\'s number, in the page\'s words', () => {
      const builder = read('connections-page/builder.js')
      expect(/var REPLACE_MOST = (\d+);/.exec(builder)?.[1]).toBe(String(CONNECTION_REPLACE_MOST))
      const most = `Replace moves at most ${CONNECTION_REPLACE_MOST} workflows at a time`
      const drawn = (ticked: number) => (ticked > CONNECTION_REPLACE_MOST
        ? `${most}. Untick ${ticked - CONNECTION_REPLACE_MOST} first.`
        : `${most}, so the first ${CONNECTION_REPLACE_MOST} are ticked. Replace again to move the rest.`)
      // The builder's own expression, with its pieces as written there.
      expect(builder).toContain('var most = "Replace moves at most " + REPLACE_MOST + " workflows at a time";')
      expect(builder).toContain('most + ". Untick " + (ticked - REPLACE_MOST) + " first." : most + ", so the first " + REPLACE_MOST + " are ticked. Replace again to move the rest."')
      expect(drawn(7)).toBe(replaceCapSentence(9, 7))
      expect(drawn(8)).toBe(replaceCapSentence(9, 8))
    })

    it('both frames list the fixture\'s nine by name, as the route orders them, the first 7 and then 8 ticked', () => {
      const fixture = JSON.parse(read('connections-page.fixture.json')) as { connections: { name: string; workflows?: string[] }[]; replaceMore: string[] }
      const six = fixture.connections.find((c) => c.name === 'Pennie Salesforce')?.workflows ?? []
      const nine = [...six, ...fixture.replaceMore].sort((a, b) => a.localeCompare(b))
      expect(nine).toHaveLength(9)
      const spec = JSON.parse(read('connections-page/settled.json')) as { frames: { id: string; variant: { inUse?: string[]; replace?: { all: string[]; ticked: number } } }[] }
      const frame = (id: string) => spec.frames.find((f) => f.id === id)?.variant
      expect(frame('replace-capped')).toMatchObject({ inUse: nine, replace: { stage: 'capped', all: nine, ticked: CONNECTION_REPLACE_MOST } })
      expect(frame('replace-over-cap')).toMatchObject({ inUse: nine, replace: { stage: 'capped', all: nine, ticked: CONNECTION_REPLACE_MOST + 1 } })
    })
  })

  // #2727 (Dan, 2026-10-28): the company mailbox Reconnect design. It was settled with no regeneration
  // folder of its own (its chrome came from this page's preview), so the map and its checks are held here.
  describe('#2727: the company mailbox Reconnect design', () => {
    const { decisions, frameIds, checks } = readSettledDesign('google-mailbox-reconnect')

    it('every checked decision has its check, on every frame it shows on, and every decision one owner', () => {
      expect(checks.map((c) => c.id)).toEqual(['D1', 'D3', 'D4'])
      expect(coverageProblems(decisions, checks, frameIds)).toEqual([])
      expect(decisions.filter((d) => !d.requirement === !d.noCode).map((d) => d.id)).toEqual([])
    })

    it("D4: its check expects the page's own fix sentence, word for word", () => {
      expect(readFileSync(design('google-mailbox-reconnect.checks.js'), 'utf8')).toContain(`var FIX = "${COMPANY_MAILBOX_FIX}";`)
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
