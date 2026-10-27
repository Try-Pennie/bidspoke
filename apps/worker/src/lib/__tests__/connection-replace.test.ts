/**
 * Replace (#2338, build PR 12; R20, D20): the rewrite of one connection's id in
 * a workflow definition, the request's body, and the sentence an incomplete
 * Replace answers with.
 *
 * What counts as naming a connection is the database's one predicate,
 * definition_connection_ids: every string VALUE of the definition, at any depth
 * and under any key, compared ignoring case and surrounding spaces. The rewrite
 * replaces exactly those strings, so after it the predicate finds the old id in
 * no string, and a Remove that follows is not refused by a string the rewrite
 * left behind.
 */
import { describe, expect, it } from 'vitest'
import {
  readReplaceBody, replaceConnectionId, replaceWorstMsPerWorkflow, REPLACE_CLIENT_WAIT_MS, REPLACE_SAVE_ATTEMPTS, REPLACE_WORKFLOWS_MAX, REPLACE_WORST_MS, type ReplacedWorkflow,
} from '../connection-replace'
import { replaceIncompleteSentence } from '../connection-create-refusals'

const OLD = 'c0000000-0000-4000-8000-0000000000aa'
const NEW = 'c0000000-0000-4000-8000-0000000000bb'
const W1 = '10000000-0000-4000-8000-000000000001'
const W2 = '10000000-0000-4000-8000-000000000002'

describe('replaceConnectionId', () => {
  it('replaces every string naming the connection, at any depth and under any key, and counts them', () => {
    const before = {
      nodes: [
        { id: 'n1', namespace: 'send', type: 'app_action', config: { connection: OLD, boundBy: 'someone' } },
        { id: 'n2', namespace: 'other', type: 'app_action', config: { connection: 'c0000000-0000-4000-8000-0000000000cc' } },
        { id: 'n3', namespace: 'deep', type: 'code', config: { list: [{ x: { y: OLD } }, 'plain text naming ' + OLD] } },
      ],
      edges: [],
    }
    const { definition, replaced } = replaceConnectionId(before, OLD, NEW)
    expect(replaced).toBe(2)
    const after = definition as typeof before
    expect(after.nodes[0].config.connection).toBe(NEW)
    expect((after.nodes[2].config as { list: Array<unknown> }).list[0]).toEqual({ x: { y: NEW } })
    // A longer string holding the id is not a reference by the predicate, so it is left as it is.
    expect((after.nodes[2].config as { list: Array<unknown> }).list[1]).toBe('plain text naming ' + OLD)
    // Another connection is untouched, and the argument is never changed.
    expect(after.nodes[1].config.connection).toBe('c0000000-0000-4000-8000-0000000000cc')
    expect(before.nodes[0].config.connection).toBe(OLD)
  })

  it('matches as the predicate does: ignoring case and surrounding spaces', () => {
    const { definition, replaced } = replaceConnectionId({ a: `  ${OLD.toUpperCase()} `, b: [OLD] }, OLD, NEW)
    expect(replaced).toBe(2)
    expect(definition).toEqual({ a: NEW, b: [NEW] })
  })

  it('leaves object keys alone, since the predicate reads values only', () => {
    const { definition, replaced } = replaceConnectionId({ [OLD]: 'x' }, OLD, NEW)
    expect(replaced).toBe(0)
    expect(definition).toEqual({ [OLD]: 'x' })
  })

  it('finds nothing in a definition that does not name it, and returns it unchanged', () => {
    const def = { nodes: [], edges: [] }
    expect(replaceConnectionId(def, OLD, NEW)).toEqual({ definition: def, replaced: 0 })
  })
})

describe('readReplaceBody', () => {
  it('reads the connection to use instead and the ticked workflows, ids lower cased and each once', () => {
    expect(readReplaceBody({ with: NEW.toUpperCase(), workflows: [W1, W2, W1] })).toEqual({ ok: true, with: NEW, workflows: [W1, W2] })
  })

  it.each([
    ['no body', null],
    ['a list', []],
    ['no replacement', { workflows: [W1] }],
    ['a replacement that is no id', { with: 'TPL2 Salesforce', workflows: [W1] }],
    ['no workflows', { with: NEW }],
    ['no workflow ticked', { with: NEW, workflows: [] }],
    ['a workflow that is no id', { with: NEW, workflows: ['Lead import'] }],
    ['a key the route does not read', { with: NEW, workflows: [W1], organization_id: W2 }],
  ])('refuses %s', (_why, raw) => {
    expect(readReplaceBody(raw)).toEqual({ ok: false, code: 'replace_body_invalid' })
  })

  // The cap is the most workflows whose worst case fits inside the page's wait (Dan, 2026-10-27), so the
  // page's stalled line cannot show while the route is still writing.
  it('caps a Replace at the most workflows whose measured worst case fits inside the page\'s wait', () => {
    const worst = (n: number) => REPLACE_WORST_MS.before + n * replaceWorstMsPerWorkflow() + REPLACE_WORST_MS.margin
    expect(replaceWorstMsPerWorkflow()).toBe(REPLACE_SAVE_ATTEMPTS * (REPLACE_WORST_MS.read + REPLACE_WORST_MS.check + REPLACE_WORST_MS.write) + REPLACE_WORST_MS.copyRead + REPLACE_WORST_MS.audit + REPLACE_WORST_MS.kv)
    expect(worst(REPLACE_WORKFLOWS_MAX)).toBeLessThanOrEqual(REPLACE_CLIENT_WAIT_MS)
    expect(worst(REPLACE_WORKFLOWS_MAX + 1)).toBeGreaterThan(REPLACE_CLIENT_WAIT_MS)
    expect(REPLACE_WORKFLOWS_MAX).toBe(7)
  })

  it(`refuses more than ${REPLACE_WORKFLOWS_MAX} workflows by its own code`, () => {
    const many = Array.from({ length: REPLACE_WORKFLOWS_MAX + 1 }, (_, i) => `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    expect(readReplaceBody({ with: NEW, workflows: many })).toEqual({ ok: false, code: 'replace_too_many' })
    expect(readReplaceBody({ with: NEW, workflows: many.slice(1) })).toMatchObject({ ok: true })
  })
})

describe('replaceIncompleteSentence', () => {
  const wf = (name: string, outcome: ReplacedWorkflow['outcome'], extra: Partial<ReplacedWorkflow> = {}): ReplacedWorkflow => ({ id: name, name, outcome, ...extra })

  it('is null when every ticked workflow uses the new connection, newly or already', () => {
    expect(replaceIncompleteSentence([wf('A', 'replaced'), wf('B', 'not_using')], 'Pennie Salesforce', 'TPL2 Salesforce')).toBeNull()
  })

  // Never a count of those moved: the dialog lists every workflow and marks each moved one (Dan, 2026-10-27, #2338 Replace round 2).
  it('names each left on the old connection and why, and what to do, with no count of those moved', () => {
    const s = replaceIncompleteSentence([wf('A', 'replaced'), wf('B', 'replaced'), wf('Lead Completed sync', 'changed'), wf('Tripoint submission', 'changed')], 'Pennie Salesforce', 'TPL2 Salesforce')
    expect(s).toBe('Lead Completed sync and Tripoint submission were saved by someone else while this ran, so they still use Pennie Salesforce. Replace again to move them.')
  })

  it('says no count when none was moved either', () => {
    const s = replaceIncompleteSentence([wf('Lead Completed sync', 'changed')], 'Pennie Salesforce', 'TPL2 Salesforce')
    expect(s).toBe('Lead Completed sync was saved by someone else while this ran, so it still uses Pennie Salesforce. Replace again to move it.')
  })

  it('says a write it could not confirm is not known, and to reload before replacing again (L11)', () => {
    const s = replaceIncompleteSentence([wf('A', 'replaced'), wf('Partner report email', 'failed')], 'Pennie Salesforce', 'TPL2 Salesforce')
    expect(s).toBe('Bidspoke could not confirm whether Partner report email got a new version. Reload the page to see, then replace again for any still on Pennie Salesforce.')
  })

  it('says the replacement was removed while it ran, and to choose another', () => {
    const s = replaceIncompleteSentence([wf('A', 'refused', { why: 'replacement_removed' })], 'Pennie Salesforce', 'TPL2 Salesforce')
    expect(s).toBe('TPL2 Salesforce was removed while this ran, so A still uses Pennie Salesforce. Choose another connection and replace again.')
  })

  it('says a workflow that also names a removed connection must have that step fixed on its canvas', () => {
    const s = replaceIncompleteSentence([wf('Old import', 'refused', { why: 'names_removed_connection' })], 'Pennie Salesforce', 'TPL2 Salesforce')
    expect(s).toBe('Old import also names a connection that was removed. Open it, give that step a connection and save, then replace again.')
  })

  it('says a check that could not be made left the workflow as it was', () => {
    const s = replaceIncompleteSentence([wf('A', 'refused', { why: 'check_failed' })], 'Pennie Salesforce', 'TPL2 Salesforce')
    expect(s).toBe('Bidspoke could not check the connections A names, so it still uses Pennie Salesforce. Replace again to move it.')
  })

  it('says a workflow it could not read still uses the old connection', () => {
    const s = replaceIncompleteSentence([wf('A', 'refused', { why: 'unreadable' })], 'Pennie Salesforce', 'TPL2 Salesforce')
    expect(s).toBe('Bidspoke could not read A, so it still uses Pennie Salesforce. Replace again to move it.')
  })

  it('says a new version the database would not take is a fault in Bidspoke, for Dan', () => {
    const s = replaceIncompleteSentence([wf('A', 'refused', { why: 'write_refused' })], 'Pennie Salesforce', 'TPL2 Salesforce')
    expect(s).toBe('The database would not take a new version of A, so it still uses Pennie Salesforce. Tell Dan, since this is a fault in Bidspoke.')
  })

  it('says a workflow deleted while it ran cannot get a new version', () => {
    const s = replaceIncompleteSentence([wf('A', 'replaced'), wf('Old import', 'deleted')], 'Pennie Salesforce', 'TPL2 Salesforce')
    expect(s).toBe('Old import was deleted, so it cannot get a new version.')
  })
})
