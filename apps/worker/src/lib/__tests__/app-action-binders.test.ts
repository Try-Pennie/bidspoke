import { describe, expect, it } from 'vitest'
import { stampAppActionBinders } from '../app-action-binders'

/**
 * Who bound each app_action step to its connection (#2339). A person's own
 * account may be used only by its owner (Dan, 2026-10-23, on #2338), so the ops
 * executor compares the step's boundBy with the connection's owner. The stamp is
 * the server's: the person writing the definition when the step's connection is
 * new or changed, the stored stamp otherwise, never a value the client sent.
 */

const DAN = '00000000-0000-4000-8000-0000000023d1'
const SAM = '00000000-0000-4000-8000-0000000023d2'
const MY_GOOGLE = '00000000-0000-4000-8000-0000000023c1'
const SAMS_GOOGLE = '00000000-0000-4000-8000-0000000023c2'

const step = (id: string, connection: string | undefined, boundBy?: unknown) => ({
  id, namespace: id, type: 'app_action',
  config: { service: 'google', action: 'google.gmail-send-email', actionVersion: 1, ...(connection ? { connection } : {}), ...(boundBy !== undefined ? { boundBy } : {}) },
})
const def = (...nodes: unknown[]) => ({ trigger: { type: 'schedule' }, nodes, edges: [] })
const boundOf = (d: unknown) => Object.fromEntries((d as { nodes: Array<{ id: string; config: { boundBy?: unknown } }> }).nodes.map((n) => [n.id, n.config.boundBy]))

describe('stampAppActionBinders', () => {
  it('stamps a new step with whoever is writing it', () => {
    expect(boundOf(stampAppActionBinders(def(step('mail', MY_GOOGLE)), null, DAN))).toEqual({ mail: DAN })
  })

  it('keeps the stored stamp of a step whose connection is unchanged, whoever saves the rest of the workflow', () => {
    const stored = def(step('mail', MY_GOOGLE, DAN))
    expect(boundOf(stampAppActionBinders(def(step('mail', MY_GOOGLE)), stored, SAM))).toEqual({ mail: DAN })
  })

  it('stamps the writer when the step\'s connection changes, so a step moved onto another person\'s account carries who moved it', () => {
    const stored = def(step('mail', MY_GOOGLE, DAN))
    expect(boundOf(stampAppActionBinders(def(step('mail', SAMS_GOOGLE)), stored, SAM))).toEqual({ mail: SAM })
  })

  it('never takes a stamp the client sent: a new step, or one claiming another binder than the stored one', () => {
    expect(boundOf(stampAppActionBinders(def(step('mail', SAMS_GOOGLE, SAM)), null, DAN))).toEqual({ mail: DAN })
    const stored = def(step('mail', MY_GOOGLE, DAN))
    expect(boundOf(stampAppActionBinders(def(step('mail', MY_GOOGLE, SAM)), stored, SAM))).toEqual({ mail: DAN })
  })

  it('stamps the writer over a stored stamp that is not a user id', () => {
    const stored = def(step('mail', MY_GOOGLE, 'someone'))
    expect(boundOf(stampAppActionBinders(def(step('mail', MY_GOOGLE)), stored, SAM))).toEqual({ mail: SAM })
  })

  it('leaves every other step, and the stored definition, untouched', () => {
    const code = { id: 'c', namespace: 'c', type: 'code', config: { script: 'return 1', boundBy: 'x' } }
    const stored = def(step('mail', MY_GOOGLE, DAN))
    const frozen = JSON.stringify(stored)
    const next = def(code, step('mail', MY_GOOGLE))
    const out = stampAppActionBinders(next, stored, SAM) as { nodes: Array<{ config: unknown }> }
    expect(out.nodes[0]).toEqual(code)
    expect(JSON.stringify(stored)).toBe(frozen)
    expect((next.nodes[1] as { config: { boundBy?: unknown } }).config.boundBy).toBeUndefined()
  })

  it('passes a definition that is not nodes and edges through as it is, for the shape refusal to name', () => {
    expect(stampAppActionBinders('not a definition', null, DAN)).toBe('not a definition')
  })
})
