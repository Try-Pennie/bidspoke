/**
 * The money gate's Main Flow fixture is exactly what the port made (#2173).
 *
 * Step 5 of the runbook (docs/main-flow-relay-port.md) refreshes the gate's
 * fixtures from production after each apply and requires no difference from the
 * definition the apply PUT. This holds that as a check rather than a reading:
 * the gate's Main Flow must equal the transform of version 169 (the port tests'
 * own copy, production-fixture.ts) at the stage last applied.
 *
 * When it fails after a refresh, something other than the port changed Main
 * Flow, most likely a canvas save. Look at that save before changing anything
 * here. When a further stage is applied, set LIVE_STAGE to it in the same pull
 * request that refreshes the fixture.
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
  it('is the transform of version 169 at the stage last applied', () => {
    expect(gate.id).toBe(MAIN_FLOW_WORKFLOW_ID)
    const expected = portMainFlow(productionMainFlow(), PORT_STAGES[LIVE_STAGE])
    // sameJson compares by meaning; on a failure, toEqual names the node that differs.
    if (!sameJson(gate.definition, expected)) expect(gate.definition).toEqual(expected)
    expect(sameJson(gate.definition, expected)).toBe(true)
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
