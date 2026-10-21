/**
 * The money gate's Main Flow fixture is fully ported at the stage last applied (#2173).
 *
 * Step 5 of the runbook (docs/main-flow-relay-port.md) refreshes the gate's
 * fixtures from production after each apply. This holds the result as a check:
 * running the live stage's transform over the gate's Main Flow changes nothing,
 * and exactly the stage's posts are native.
 *
 * It used to require the gate's Main Flow to EQUAL the transform of version 169
 * (production-fixture.ts). That failed on every canvas save, and Brian and Dan
 * edit Main Flow on the canvas as a matter of course (2026-10-21: version 173's
 * fallback timestamp and Engine Debt edits, bidspoke#2581, #2583). The transform
 * itself is still tested against version 169 in transform.test.ts; what this
 * file checks is that the port's work survives on the live definition.
 *
 * When a further stage is applied, set LIVE_STAGE to it in the same pull request
 * that refreshes the fixture.
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import GATE_MAIN_FLOW_RAW from '../../../../money-gate/fixtures/definitions/60e2e0bc-5aa2-47db-b333-3a8fe1c62e09.json?raw'
import { MAIN_FLOW_WORKFLOW_ID, OUTCOME_POSTS, PORT_STAGES, portMainFlow, portStatus, sameJson, type Definition, type PortOptions, type PortStage } from '../transform'
import { productionMainFlow } from './production-fixture'

/** The stage live on Main Flow: applied 2026-10-16 as version 172 (#2173). */
const LIVE_STAGE: PortStage = 'canary_invalid_state'

const gate = JSON.parse(GATE_MAIN_FLOW_RAW as string) as { id: string; definition: Definition }

describe("the money gate's Main Flow fixture", () => {
  it('is unchanged by the transform of the stage last applied, so nothing the port did was undone', () => {
    expect(gate.id).toBe(MAIN_FLOW_WORKFLOW_ID)
    const again = portMainFlow(gate.definition, PORT_STAGES[LIVE_STAGE])
    // sameJson compares by meaning; on a failure, toEqual names the node that differs.
    if (!sameJson(again, gate.definition)) expect(again).toEqual(gate.definition)
    expect(sameJson(again, gate.definition)).toBe(true)
  })

  it('would fail on a Main Flow the stage was never applied to (control)', () => {
    const unported = productionMainFlow()
    expect(sameJson(portMainFlow(unported, PORT_STAGES[LIVE_STAGE]), unported)).toBe(false)
  })

  it('has exactly the stage\'s posts native and every other post still on the relay', () => {
    const stage: PortOptions = PORT_STAGES[LIVE_STAGE]
    const ported = stage.posts === 'all' ? [...OUTCOME_POSTS] : [...stage.posts]
    const status = portStatus(gate.definition)
    expect(status.ported.sort()).toEqual(ported.sort())
    expect(status.relay.sort()).toEqual(OUTCOME_POSTS.filter((p) => !ported.includes(p)).sort())
    expect(status.inquiryMoved).toBe(stage.moveInquiry)
  })
})
