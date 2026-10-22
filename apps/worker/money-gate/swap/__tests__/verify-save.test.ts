/**
 * The check after a lead validation swap is saved (#2592): the saved step is
 * byte for byte the proven candidate, and nothing else in the definition moved
 * except what the canvas paste necessarily changes (the step's id, the two edge
 * ids, and card positions), each said apart from a real difference.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseCandidate, type SwapCandidate } from '../candidate'
import { formatSwapVerification, verifySavedSwap, type DefinitionVersion } from '../verify-save'
import gigfi from '../candidates/rml-gigfi.json'
import lendswift from '../candidates/rml-lendswift.json'
import leadEconomy from '../candidates/lead-economy.json'
import gigfiBeforeSwap from '../replaced/rml-gigfi-v24.json'
import gigfiSaved from '../../fixtures/definitions/6624acd0-bf61-4d21-85fc-4371ca7ed77d.json'
import lendswiftDef from '../../fixtures/definitions/e1b810da-16c0-49eb-bf12-ba1c9b67c914.json'
import leadEconomyDef from '../../fixtures/definitions/89b1a6af-7e0f-43de-bc66-1e888184551f.json'

type Def = { trigger?: unknown; nodes: Array<{ id: string; [k: string]: unknown }>; edges: Array<{ id?: string; source: string; target: string; [k: string]: unknown }> }

const candidate = parseCandidate(gigfi, 'rml-gigfi.json')
const OLD = candidate.replaces.node_id
const NEW = '11111111-2222-4333-8444-555555555555'
// GigFi's version 24, the version before its swap (#2592): the money gate's
// definition holds the saved node since the refresh, so the copy kept for the grid is the base.
const previousDef = (gigfiBeforeSwap as unknown as { definition: Def }).definition
const savedDef = (gigfiSaved as unknown as { definition: Def }).definition
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** What the canvas saves after Delete, paste and one wire drag: a new id, the node appended, new edge ids. */
function canvasSave(over: (d: Def) => void = () => {}): Def {
  const d = clone(previousDef)
  const old = d.nodes.find((n) => n.id === OLD)!
  d.nodes = d.nodes.filter((n) => n.id !== OLD)
  d.nodes.push({ id: NEW, namespace: candidate.node.namespace, label: candidate.node.label, type: 'lead_validation', position: old.position, config: clone(candidate.node.config), variables: {} })
  d.edges = d.edges.map((e) => (e.source === OLD || e.target === OLD
    ? { ...e, id: `new-${String(e.id)}`, source: e.source === OLD ? NEW : e.source, target: e.target === OLD ? NEW : e.target }
    : e))
  over(d)
  return d
}

const v = (n: number, definition: Def): DefinitionVersion => ({ version_number: n, definition })
const verify = (saved: Def, live: Def = saved, previous: Def = previousDef) => verifySavedSwap(candidate, v(24, previous), v(25, saved), live)

describe('verifySavedSwap', () => {
  it('passes GigFi as Dan saved it on 2026-10-22 (version 25), with only what a paste changes as notes', () => {
    const r = verify(savedDef)
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
    const saved = savedDef.nodes.find((n) => n.namespace === candidate.node.namespace)!
    expect(r.notes.join('\n')).toContain(`the step's id changed from ${OLD} to ${saved.id}`)
    expect(r.notes.join('\n')).toContain('2 edges into or out of the step were made again with new ids')
  })

  it('passes the canvas swap, naming the new step id and the two re-made edges', () => {
    const r = verify(canvasSave())
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.notes.join('\n')).toContain(`the step's id changed from ${OLD} to ${NEW}`)
    expect(r.notes.join('\n')).toContain('2 edges into or out of the step were made again with new ids')
  })

  it('passes a swap that kept the step id and its edges, with nothing to note', () => {
    const d = clone(previousDef)
    d.nodes = d.nodes.map((n) => (n.id === OLD ? { id: OLD, namespace: candidate.node.namespace, label: candidate.node.label, type: 'lead_validation', position: n.position, config: clone(candidate.node.config), variables: {} } : n))
    const r = verify(d)
    expect(r).toEqual({ ok: true, problems: [], notes: [] })
  })

  it('lists cards the layout moved as notes, never as problems', () => {
    const r = verify(canvasSave((d) => { d.nodes[5].position = { x: 394, y: 999 } }))
    expect(r.ok).toBe(true)
    expect(r.notes.join('\n')).toMatch(/moved on the canvas only: .+/)
  })

  it('fails when the saved step is not the proven config, naming where it differs', () => {
    const r = verify(canvasSave((d) => {
      const n = d.nodes.find((x) => x.id === NEW) as unknown as { config: { checks: Array<{ reason: string }> } }
      n.config.checks[1].reason = 'invalid name'
    }))
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toContain('config.checks[1].reason')
  })

  it('fails when the label or the type moved', () => {
    expect(verify(canvasSave((d) => { d.nodes.find((x) => x.id === NEW)!.label = 'Validate' })).problems.join('\n')).toContain('label')
    expect(verify(canvasSave((d) => { d.nodes.find((x) => x.id === NEW)!.type = 'code' })).ok).toBe(false)
  })

  it('fails on any change to another step, an edge, or the trigger', () => {
    const other = verify(canvasSave((d) => { (d.nodes[0].config as Record<string, unknown>).retries = 9 }))
    expect(other.ok).toBe(false)
    expect(other.problems.join('\n')).toContain(String(previousDef.nodes[0].namespace))
    const rewired = verify(canvasSave((d) => { d.edges[d.edges.length - 1].source_handle = 'else' }))
    expect(rewired.ok).toBe(false)
    const dropped = verify(canvasSave((d) => { d.edges = d.edges.filter((e) => e.target !== NEW) }))
    expect(dropped.problems.join('\n')).toMatch(/edge .* is missing/)
    const trigger = verify(canvasSave((d) => { d.trigger = { type: 'webhook', changed: true } }))
    expect(trigger.problems.join('\n')).toContain('trigger')
  })

  it('fails when an edge that does not touch the step changed id', () => {
    const r = verify(canvasSave((d) => {
      const e = d.edges.find((x) => x.source !== NEW && x.target !== NEW)!
      e.id = 'renamed'
    }))
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toContain('renamed')
  })

  it('fails when the live workflow is not the saved version', () => {
    const r = verify(canvasSave(), clone(previousDef))
    expect(r.problems.join('\n')).toContain('the live workflow is not version 25')
  })

  it('fails when the version before the save does not hold the pinned script', () => {
    const edited = clone(previousDef)
    const n = edited.nodes.find((x) => x.id === OLD) as unknown as { config: { script: string } }
    n.config.script += '\n// edited'
    expect(createHash('md5').update(n.config.script).digest('hex')).not.toBe(candidate.replaces.script_md5)
    const r = verify(canvasSave(), undefined, edited)
    expect(r.problems.join('\n')).toContain('version 24 does not hold the script the proofs compared against')
  })

  it('fails when the step appears twice, or not at all', () => {
    expect(verify(canvasSave((d) => { d.nodes.push({ ...d.nodes.find((x) => x.id === NEW)!, id: 'dup' }) })).ok).toBe(false)
    expect(verify(canvasSave((d) => { d.nodes = d.nodes.filter((x) => x.id !== NEW) })).ok).toBe(false)
  })
})

/** The same canvas save for any candidate: the old step deleted, the candidate pasted with a new id, its two edges made again, and the Constants the candidate sets typed in. */
function canvasSaveOf(c: SwapCandidate, def: Def, over: (d: Def) => void = () => {}, typeConstants = true): Def {
  const d = clone(def)
  const oldId = c.replaces.node_id
  const old = d.nodes.find((n) => n.id === oldId)!
  d.nodes = d.nodes.filter((n) => n.id !== oldId)
  d.nodes.push({ id: NEW, namespace: c.node.namespace, label: c.node.label, type: 'lead_validation', position: old.position, config: clone(c.node.config), variables: {} })
  d.edges = d.edges.map((e) => (e.source === oldId || e.target === oldId
    ? { ...e, id: `new-${String(e.id)}`, source: e.source === oldId ? NEW : e.source, target: e.target === oldId ? NEW : e.target }
    : e))
  if (typeConstants && c.constants_data) {
    const k = d.nodes.find((n) => n.type === 'constants') as unknown as { config: { data: Record<string, unknown> } }
    k.config.data = { ...k.config.data, ...clone(c.constants_data) }
  }
  over(d)
  return d
}

describe('verifySavedSwap: RML LendSwift (#2593)', () => {
  const ls = parseCandidate(lendswift, 'rml-lendswift.json')
  const before = (lendswiftDef as unknown as { definition: Def }).definition
  const check = (saved: Def) => verifySavedSwap(ls, v(24, before), v(25, saved), saved)

  it('passes the canvas swap of the live version 24, which the committed fixture is', () => {
    const r = check(canvasSaveOf(ls, before))
    expect(r.problems).toEqual([])
    expect(r.notes.join('\n')).toContain('2 edges into or out of the step were made again with new ids')
    expect(formatSwapVerification(r, 'LendSwift').split('\n')[0]).toBe('LendSwift: PASS, only the validation step changed')
  })

  it('fails when the pasted step is GigFi\'s (it reads steps.parsed_name, which LendSwift does not have)', () => {
    const r = check(canvasSaveOf(ls, before, (d) => {
      const n = d.nodes.find((x) => x.id === NEW) as unknown as { config: unknown }
      n.config = clone(candidate.node.config)
    }))
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toContain('config.checks[2].condition.groups[0].conditions[0].field')
  })

  it('fails on any change to its Constants, which this swap does not set', () => {
    const r = check(canvasSaveOf(ls, before, (d) => {
      const k = d.nodes.find((n) => n.type === 'constants') as unknown as { config: { data: Record<string, unknown> } }
      k.config.data.maximumLoanAmount = 6000
    }))
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toContain('config.data.maximumLoanAmount')
  })
})

describe('verifySavedSwap: Lead Economy (#2594), whose save also sets Constants minimumLoanAmount to 2000', () => {
  const le = parseCandidate(leadEconomy, 'lead-economy.json')
  const before = (leadEconomyDef as unknown as { definition: Def }).definition
  const constantsOf = (d: Def) => (d.nodes.find((n) => n.type === 'constants') as unknown as { config: { data: Record<string, unknown> } }).config.data
  const check = (saved: Def, previous: Def = before) => verifySavedSwap(le, v(39, previous), v(40, saved), saved)

  it('starts from the live version 39, whose Constants minimum is 1000', () => {
    expect(constantsOf(before).minimumLoanAmount).toBe(1000)
    expect(le.constants_data).toEqual({ minimumLoanAmount: 2000 })
  })

  it('passes the canvas swap with the Constants minimum typed in, naming that change', () => {
    const r = check(canvasSaveOf(le, before))
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.notes.join('\n')).toContain('the Constants step\'s minimumLoanAmount changed from 1000 to 2000, as the candidate sets')
    expect(formatSwapVerification(r, 'Lead Economy').split('\n')[0]).toBe('Lead Economy: PASS, only the validation step and the Constants values the candidate sets changed')
  })

  it('fails when the Constants minimum was not changed, naming the value it expected', () => {
    const r = check(canvasSaveOf(le, before, () => {}, false))
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toContain('the Constants step\'s minimumLoanAmount is 1000, not the 2000 the candidate sets')
  })

  it('fails when the Constants minimum was typed as text, or as another number', () => {
    expect(check(canvasSaveOf(le, before, (d) => { constantsOf(d).minimumLoanAmount = '2000' })).problems.join('\n')).toContain('minimumLoanAmount is "2000", not the 2000')
    expect(check(canvasSaveOf(le, before, (d) => { constantsOf(d).minimumLoanAmount = 20000 })).ok).toBe(false)
  })

  it('fails when any other Constants value changed alongside it', () => {
    const r = check(canvasSaveOf(le, before, (d) => { constantsOf(d).minimumAnnualIncome = 40000 }))
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toContain('config.data.minimumAnnualIncome')
  })

  it('passes, with nothing to note for Constants, when the minimum was already 2000 in the version before', () => {
    const already = clone(before)
    constantsOf(already).minimumLoanAmount = 2000
    const r = check(canvasSaveOf(le, already), already)
    expect(r.ok).toBe(true)
    expect(r.notes.join('\n')).not.toContain('Constants')
  })
})
