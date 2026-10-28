/**
 * The money gate's Main Flow fixture holds every stage applied to Main Flow so far
 * (#2173, then canary_send_salesforce, #2174).
 *
 * Step 5 of the runbook (docs/main-flow-relay-port.md) refreshes the gate's
 * fixtures from production after each apply. This holds the result as a check:
 * running each applied stage's transform over the gate's Main Flow changes
 * nothing, and exactly the applied stages' posts are native, the inquiry moved
 * only if a stage moved it, and parallel_1 holds the collections slot (#2832)
 * only if that stage was applied.
 *
 * It used to require the gate's Main Flow to EQUAL the transform of version 169
 * (production-fixture.ts). That failed on every canvas save, and Brian and Dan
 * edit Main Flow on the canvas as a matter of course (2026-10-21: version 173's
 * fallback timestamp and Engine Debt edits, bidspoke#2581, #2583). The transform
 * itself is still tested against version 169 in transform.test.ts; what this
 * file checks is that the port's work survives on the live definition.
 *
 * It names every stage applied, not only the last, because the collections stage
 * may be applied before outcome_posts and inquiry or after them (#2832), so the
 * last stage alone does not say what Main Flow holds. When a further stage is
 * applied, add it to the end of APPLIED_STAGES in the same pull request that
 * refreshes the fixture.
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import GATE_MAIN_FLOW_RAW from '../../../../money-gate/fixtures/definitions/60e2e0bc-5aa2-47db-b333-3a8fe1c62e09.json?raw'
import { MAIN_FLOW_WORKFLOW_ID, OUTCOME_POSTS, PORT_STAGES, portMainFlow, portStatus, sameJson, type Definition, type OutcomePost, type PortStage } from '../transform'
import { productionMainFlow } from './production-fixture'

/**
 * The stages applied to live Main Flow, in the order they were applied:
 * canary_invalid_state as version 172 (2026-10-16, #2173), canary_send_salesforce
 * as version 175 (2026-10-26, #2174), collections as version 177 (2026-10-28,
 * #2832, over version 176, a canvas save raising send_salesforce's timeout).
 */
const APPLIED_STAGES: readonly PortStage[] = ['canary_invalid_state', 'canary_send_salesforce', 'collections']

const gate = JSON.parse(GATE_MAIN_FLOW_RAW as string) as { id: string; definition: Definition }

/** What Main Flow holds once these stages are applied, in any order. */
function heldBy(stages: readonly PortStage[]): { ported: OutcomePost[]; inquiryMoved: boolean; collections: boolean } {
  const options = stages.map((s) => PORT_STAGES[s] as { posts: 'all' | readonly OutcomePost[]; moveInquiry: boolean; collections?: boolean })
  const ported = OUTCOME_POSTS.filter((p) => options.some((o) => o.posts === 'all' || o.posts.includes(p)))
  return { ported, inquiryMoved: options.some((o) => o.moveInquiry), collections: options.some((o) => o.collections === true) }
}

describe("the money gate's Main Flow fixture", () => {
  it.each(APPLIED_STAGES)('is unchanged by the transform of %s, so nothing the port did was undone', (stage) => {
    expect(gate.id).toBe(MAIN_FLOW_WORKFLOW_ID)
    const again = portMainFlow(gate.definition, PORT_STAGES[stage])
    // sameJson compares by meaning; on a failure, toEqual names the node that differs.
    if (!sameJson(again, gate.definition)) expect(again).toEqual(gate.definition)
    expect(sameJson(again, gate.definition)).toBe(true)
  })

  it('would fail on a Main Flow the last stage was never applied to (control)', () => {
    const unported = productionMainFlow()
    expect(sameJson(portMainFlow(unported, PORT_STAGES[APPLIED_STAGES[APPLIED_STAGES.length - 1]]), unported)).toBe(false)
  })

  it('holds exactly what the applied stages built: their posts native and every other on the relay, the inquiry and the collections slot as they left them', () => {
    const held = heldBy(APPLIED_STAGES)
    const status = portStatus(gate.definition)
    expect(status.ported.sort()).toEqual([...held.ported].sort())
    expect(status.relay.sort()).toEqual(OUTCOME_POSTS.filter((p) => !held.ported.includes(p)).sort())
    expect(status.inquiryMoved).toBe(held.inquiryMoved)
    expect(status.collections).toBe(held.collections)
  })
})

describe('what a list of applied stages holds (#2832)', () => {
  it('is the same whichever side of outcome_posts and inquiry the collections stage was applied on', () => {
    const early = heldBy(['canary_invalid_state', 'canary_send_salesforce', 'collections', 'outcome_posts', 'inquiry'])
    const late = heldBy(['canary_invalid_state', 'canary_send_salesforce', 'outcome_posts', 'inquiry', 'collections'])
    expect(early).toEqual(late)
    expect(early).toEqual({ ported: [...OUTCOME_POSTS], inquiryMoved: true, collections: true })
  })

  it('matches what the transform builds for those stages, so this check reads the definition the same way the apply built it', () => {
    for (const stages of [
      ['canary_invalid_state', 'canary_send_salesforce', 'collections'],
      ['canary_invalid_state', 'canary_send_salesforce', 'collections', 'outcome_posts'],
      ['canary_invalid_state', 'canary_send_salesforce', 'outcome_posts', 'inquiry'],
    ] as PortStage[][]) {
      const def = stages.reduce((d, s) => portMainFlow(d, PORT_STAGES[s]), productionMainFlow())
      const status = portStatus(def)
      expect({ stages, held: { ported: [...status.ported].sort(), inquiryMoved: status.inquiryMoved, collections: status.collections } })
        .toEqual({ stages, held: { ...heldBy(stages), ported: [...heldBy(stages).ported].sort() } })
    }
  })
})
