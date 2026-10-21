/**
 * The check after a lead validation swap is saved (#2592): the saved step is
 * byte for byte the proven candidate, and nothing else in the definition moved
 * except what the canvas paste necessarily changes (the step's id, the two edge
 * ids, and card positions), each said apart from a real difference.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseCandidate } from '../candidate'
import { verifySavedSwap, type DefinitionVersion } from '../verify-save'
import gigfi from '../candidates/rml-gigfi.json'
import gigfiDef from '../../fixtures/definitions/6624acd0-bf61-4d21-85fc-4371ca7ed77d.json'

type Def = { trigger?: unknown; nodes: Array<{ id: string; [k: string]: unknown }>; edges: Array<{ id?: string; source: string; target: string; [k: string]: unknown }> }

const candidate = parseCandidate(gigfi, 'rml-gigfi.json')
const OLD = candidate.replaces.node_id
const NEW = '11111111-2222-4333-8444-555555555555'
const previousDef = (gigfiDef as unknown as { definition: Def }).definition
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
