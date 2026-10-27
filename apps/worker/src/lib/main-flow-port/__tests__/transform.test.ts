/**
 * The Main Flow port transform (#2171, phase 2 of #1680): what it builds and
 * every shape it refuses.
 *
 * The transform is the only route from the live canvas to a ported definition,
 * so a canvas edit to one of the parts it rewrites must stop the apply by name
 * rather than be guessed at. Each refusal below is a real edit somebody could make
 * on the canvas, applied to the production definition.
 */
import { describe, expect, it } from 'vitest'
import { sanitizeCodeNodeScripts } from '@bidspoke/script-hygiene'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import GATE_MAIN_FLOW_RAW from '../../../../money-gate/fixtures/definitions/60e2e0bc-5aa2-47db-b333-3a8fe1c62e09.json?raw'
import {
  OUTCOME_POSTS,
  PORT_STAGES,
  MainFlowPortRefusal,
  COLLECTIONS_APEX,
  COLLECTIONS_APEX_PATH,
  COLLECTIONS_BODY,
  COLLECTIONS_SLOT,
  INQUIRY_APEX_PATH,
  inquiryApexNamespace,
  inquiryBodyNamespace,
  portMainFlow,
  portStatus,
  type Definition,
  type PortOptions,
  type PortStage,
} from '../transform'
import { nextOf, nodeByNamespace, productionMainFlow, relayUrls } from './production-fixture'

/** Everything the port does at once: every post, the inquiry moved, and the collections slot (#2832). */
const FULL: PortOptions = { posts: 'all', moveInquiry: true, collections: true }

/** Main Flow as the money gate holds it: the live version 175, canary_send_salesforce applied. */
const live = (): Definition => structuredClone((JSON.parse(GATE_MAIN_FLOW_RAW as string) as { definition: Definition }).definition)

/** The same definition whatever order its nodes and edges are listed in. */
const canonical = (d: Definition) => ({
  ...d,
  nodes: [...d.nodes].sort((a, b) => a.id.localeCompare(b.id)),
  edges: [...d.edges].sort((a, b) => a.id.localeCompare(b.id)),
})

const applyAll = (def: Definition, stages: readonly PortStage[]) => stages.reduce((d, s) => portMainFlow(d, PORT_STAGES[s]), def)

function refusalOf(def: unknown, options: PortOptions = FULL): string[] {
  try {
    portMainFlow(def, options)
  } catch (err) {
    if (err instanceof MainFlowPortRefusal) return err.reasons
    throw err
  }
  throw new Error('the transform did not refuse')
}

const COLLECTIONS_CHILD = { id: COLLECTIONS_SLOT, label: 'collections', on_failure: 'continue' }

describe('portMainFlow over the production definition', () => {
  it('turns every outcome post into a native Submission update under its own namespace', () => {
    const ported = portMainFlow(productionMainFlow(), FULL)
    for (const ns of OUTCOME_POSTS) {
      const node = nodeByNamespace(ported, ns)
      expect({ ns, type: node.type, operation: node.config.operation, object: node.config.object }).toEqual({
        ns, type: 'salesforce', operation: 'update', object: 'Submission__c',
      })
    }
    expect(portStatus(ported)).toEqual({ ported: [...OUTCOME_POSTS], relay: [], inquiryMoved: true, collections: true })
  })

  it('keeps the node id, label and position of each post, so the canvas keeps its layout and success accounting', () => {
    const before = productionMainFlow()
    const ported = portMainFlow(before, FULL)
    for (const ns of OUTCOME_POSTS) {
      const a = nodeByNamespace(before, ns)
      const b = nodeByNamespace(ported, ns)
      expect({ id: b.id, label: b.label, position: b.position }).toEqual({ id: a.id, label: a.label, position: a.position })
    }
  })

  it('takes the record id from the same place the relay read it, the body submissionId', () => {
    const ported = portMainFlow(productionMainFlow(), FULL)
    expect(nodeByNamespace(ported, 'send_salesforce').config.record_id).toBe('{{trigger.payload.Submission__c}}')
    expect(nodeByNamespace(ported, 'invalid_state_sf_post').config.record_id).toBe('{{steps.fallback_invalid_state.output.sfBody.submissionId}}')
    expect(nodeByNamespace(ported, 'engine_no_bids_sf_post').config.record_id).toBe(
      '{{steps.engine_no_bids_call.output.sfBody.submissionId ?? steps.engine_no_bids_call_1.output.sfBody.submissionId}}',
    )
  })

  it('keeps each body template exactly, text bodies as text', () => {
    const before = productionMainFlow()
    const ported = portMainFlow(before, FULL)
    for (const ns of OUTCOME_POSTS) {
      expect({ ns, body: nodeByNamespace(ported, ns).config.body }).toEqual({ ns, body: nodeByNamespace(before, ns).config.body })
    }
    expect(typeof nodeByNamespace(ported, 'send_salesforce').config.body).toBe('string')
  })

  it('drops the inquiry relay from parallel_1 and leaves the trades chain and the collections slot in it', () => {
    const ported = portMainFlow(productionMainFlow(), FULL)
    expect(ported.nodes.some((n) => n.namespace === 'send_salesforce_inquiry')).toBe(false)
    expect(nodeByNamespace(ported, 'parallel_1').config.children).toEqual([{ id: 'child-0', label: 'pennie_debt_calc' }, COLLECTIONS_CHILD])
    expect(nextOf(ported, 'parallel_1').sort()).toEqual(['child-0:trades_body', `${COLLECTIONS_SLOT}:${COLLECTIONS_BODY}`, 'output:parallel_end_1'])
  })

  it('puts the inquiry body then its Apex call straight after every outcome write, before what followed it, with no block around them', () => {
    const before = productionMainFlow()
    const ported = portMainFlow(before, FULL)
    for (const ns of OUTCOME_POSTS) {
      const after = nextOf(before, ns)
      expect({ ns, next: nextOf(ported, ns) }).toEqual({ ns, next: [`output:${inquiryBodyNamespace(ns)}`] })
      expect({ ns, next: nextOf(ported, inquiryBodyNamespace(ns)) }).toEqual({ ns, next: [`output:${inquiryApexNamespace(ns)}`] })
      expect({ ns, next: nextOf(ported, inquiryApexNamespace(ns)) }).toEqual({ ns, next: after })
      expect({ ns, apex: nodeByNamespace(ported, inquiryApexNamespace(ns)).config }).toEqual({ ns, apex: {
        operation: 'apex', apex_path: INQUIRY_APEX_PATH, body: `{{steps.${inquiryBodyNamespace(ns)}.output}}`, skip_when_empty: true, retries: 0, timeout_ms: 4_500,
      } })
    }
    expect(ported.nodes.filter((n) => n.type === 'parallel').map((n) => n.namespace)).toEqual(['parallel_1'])
  })

  it('names neither relay anywhere once fully ported', () => {
    const before = productionMainFlow()
    const urls = relayUrls(before)
    const text = JSON.stringify(portMainFlow(before, FULL))
    expect(text.includes(new URL(urls.submission).host)).toBe(false)
    expect(text.includes(new URL(urls.inquiries).host)).toBe(false)
  })

  it('is what the save route stores: scripts carry nothing the route strips', () => {
    const ported = portMainFlow(productionMainFlow(), FULL)
    expect(sanitizeCodeNodeScripts(structuredClone(ported))).toEqual(ported)
  })

  it('does not change the definition it was given', () => {
    const before = productionMainFlow()
    const copy = structuredClone(before)
    portMainFlow(before, FULL)
    expect(before).toEqual(copy)
  })

  it('touches nothing but the posts, the inquiry relay, parallel_1 and the nodes it adds', () => {
    const before = productionMainFlow()
    const ported = portMainFlow(before, FULL)
    const touched = new Set<string>([...OUTCOME_POSTS, 'parallel_1', 'send_salesforce_inquiry', COLLECTIONS_BODY, COLLECTIONS_APEX, ...OUTCOME_POSTS.flatMap((p) => [
      inquiryBodyNamespace(p), inquiryApexNamespace(p),
    ])])
    const untouched = (d: Definition) => d.nodes.filter((n) => !touched.has(n.namespace))
    expect(untouched(ported)).toEqual(untouched(before))
    expect(ported.trigger).toEqual(before.trigger)
  })
})

describe('the collections stage (#2832): a slot of parallel_1, before the answer', () => {
  it('over live Main Flow (canary_send_salesforce, version 175) ports nothing and adds the collections body and Apex call alone', () => {
    const before = live()
    const after = portMainFlow(before, PORT_STAGES.collections)
    expect(portStatus(before)).toMatchObject({ collections: false })
    expect(portStatus(after)).toEqual({ ...portStatus(before), collections: true })
    const added = after.nodes.filter((n) => !before.nodes.some((b) => b.id === n.id)).map((n) => n.namespace).sort()
    expect(added).toEqual([COLLECTIONS_APEX, COLLECTIONS_BODY])
    // Every node already there is unchanged but parallel_1, which names the new slot.
    const changed = before.nodes.filter((n) => JSON.stringify(n) !== JSON.stringify(after.nodes.find((a) => a.id === n.id))).map((n) => n.namespace)
    expect(changed).toEqual(['parallel_1'])
    expect(after.edges.slice(0, before.edges.length)).toEqual(before.edges)
    expect(nodeByNamespace(after, 'send_salesforce_inquiry').type).toBe('webhook')
  })

  it('is a third slot of parallel_1, beside the trades chain and the inquiry relay, marked continue, the settings otherwise as they were', () => {
    const before = nodeByNamespace(live(), 'parallel_1')
    const after = portMainFlow(live(), PORT_STAGES.collections)
    const p = nodeByNamespace(after, 'parallel_1')
    expect(p.config).toEqual({ ...before.config, children: [...(before.config.children as unknown[]), COLLECTIONS_CHILD] })
    expect(p.config).toMatchObject({ wait_for: 'all', on_child_error: 'fail', on_timeout: 'partial', timeout_ms: 20_000 })
    expect(nextOf(after, 'parallel_1').sort()).toEqual(['child-0:trades_body', 'child-1:send_salesforce_inquiry', `${COLLECTIONS_SLOT}:${COLLECTIONS_BODY}`, 'output:parallel_end_1'])
    expect(nextOf(after, COLLECTIONS_BODY)).toEqual([`output:${COLLECTIONS_APEX}`])
    expect(nextOf(after, COLLECTIONS_APEX)).toEqual(['output:parallel_end_1'])
  })

  it('posts once to credit-collections, 4.5 s, skipped only for a null body; its body step has one 500 ms attempt', () => {
    const after = portMainFlow(live(), PORT_STAGES.collections)
    expect(nodeByNamespace(after, COLLECTIONS_APEX).config).toEqual({
      operation: 'apex', apex_path: COLLECTIONS_APEX_PATH, body: `{{steps.${COLLECTIONS_BODY}.output}}`, skip_when_empty: true, retries: 0, timeout_ms: 4_500,
    })
    expect(nodeByNamespace(after, COLLECTIONS_APEX).type).toBe('salesforce')
    expect(nodeByNamespace(after, COLLECTIONS_BODY)).toMatchObject({ type: 'code', config: { retries: 0, timeout_ms: 500 } })
  })

  it('outcome_posts and inquiry applied later keep the collections slot exactly as it is', () => {
    const withSlot = portMainFlow(live(), PORT_STAGES.collections)
    const slot = (d: Definition) => {
      const ids = new Set(d.nodes.filter((n) => n.namespace === COLLECTIONS_BODY || n.namespace === COLLECTIONS_APEX).map((n) => n.id))
      return { nodes: d.nodes.filter((n) => ids.has(n.id)), edges: d.edges.filter((e) => ids.has(e.source) || ids.has(e.target)) }
    }
    const posts = portMainFlow(withSlot, PORT_STAGES.outcome_posts)
    expect(slot(posts)).toEqual(slot(withSlot))
    expect(nodeByNamespace(posts, 'parallel_1').config).toEqual(nodeByNamespace(withSlot, 'parallel_1').config)
    const inquiry = portMainFlow(posts, PORT_STAGES.inquiry)
    expect(slot(inquiry)).toEqual(slot(withSlot))
    // The inquiry relay leaves parallel_1; the collections slot stays in it.
    expect(nodeByNamespace(inquiry, 'parallel_1').config.children).toEqual([{ id: 'child-0', label: 'pennie_debt_calc' }, COLLECTIONS_CHILD])
    expect(portStatus(inquiry)).toEqual({ ported: expect.arrayContaining([...OUTCOME_POSTS]), relay: [], inquiryMoved: true, collections: true })
  })

  it('outcome_posts and inquiry never add the slot when it is absent', () => {
    const posts = portMainFlow(live(), PORT_STAGES.outcome_posts)
    const inquiry = portMainFlow(posts, PORT_STAGES.inquiry)
    for (const d of [posts, inquiry]) {
      expect(portStatus(d).collections).toBe(false)
      expect(d.nodes.some((n) => n.namespace === COLLECTIONS_BODY || n.namespace === COLLECTIONS_APEX)).toBe(false)
    }
    expect(nodeByNamespace(inquiry, 'parallel_1').config.children).toEqual([{ id: 'child-0', label: 'pennie_debt_calc' }])
  })

  it('applied after the inquiry has moved, it adds the same slot to parallel_1', () => {
    const inquiry = applyAll(live(), ['outcome_posts', 'inquiry'])
    const after = portMainFlow(inquiry, PORT_STAGES.collections)
    expect(nodeByNamespace(after, 'parallel_1').config.children).toEqual([{ id: 'child-0', label: 'pennie_debt_calc' }, COLLECTIONS_CHILD])
    expect(after.nodes.filter((n) => !inquiry.nodes.some((m) => m.id === n.id)).map((n) => n.namespace).sort()).toEqual([COLLECTIONS_APEX, COLLECTIONS_BODY])
  })
})

describe('stages', () => {
  it('are listed in the order they are applied: the collections slot before the rest of #1680', () => {
    expect(Object.keys(PORT_STAGES)).toEqual(['canary_invalid_state', 'canary_send_salesforce', 'collections', 'outcome_posts', 'inquiry'])
  })

  it('the canary stage ports invalid_state_sf_post alone and leaves the inquiry relay where it is', () => {
    const ported = portMainFlow(productionMainFlow(), PORT_STAGES.canary_invalid_state)
    expect(portStatus(ported)).toEqual({
      ported: ['invalid_state_sf_post'],
      relay: OUTCOME_POSTS.filter((p) => p !== 'invalid_state_sf_post'),
      inquiryMoved: false,
      collections: false,
    })
    expect(nextOf(ported, 'invalid_state_sf_post')).toEqual(['output:achieve_invalid_state'])
    expect(nodeByNamespace(ported, 'send_salesforce_inquiry').type).toBe('webhook')
  })

  it('each stage in its order builds on the one before to exactly the result of porting at once', () => {
    expect(applyAll(productionMainFlow(), Object.keys(PORT_STAGES) as PortStage[])).toEqual(portMainFlow(productionMainFlow(), FULL))
  })

  it('the collections stage applied later instead, after outcome_posts or after inquiry, builds the same definition', () => {
    const atOnce = canonical(portMainFlow(productionMainFlow(), FULL))
    for (const order of [
      ['canary_invalid_state', 'canary_send_salesforce', 'outcome_posts', 'collections', 'inquiry'],
      ['canary_invalid_state', 'canary_send_salesforce', 'outcome_posts', 'inquiry', 'collections'],
    ] as PortStage[][]) {
      expect({ order, def: canonical(applyAll(productionMainFlow(), order)) }).toEqual({ order, def: atOnce })
    }
  })

  it('applying a stage twice changes nothing the second time', () => {
    for (const stage of Object.values(PORT_STAGES)) {
      const once = portMainFlow(productionMainFlow(), stage)
      expect(portMainFlow(once, stage)).toEqual(once)
    }
  })

  it('every stage leaves a fully ported definition exactly as it is', () => {
    const full = portMainFlow(productionMainFlow(), FULL)
    for (const [name, stage] of Object.entries(PORT_STAGES)) expect({ name, def: portMainFlow(full, stage) }).toEqual({ name, def: full })
  })

  it('the inquiry stage puts the inquiry pair after each write and touches parallel_1 only to drop the relay', () => {
    const inquiry = applyAll(productionMainFlow(), ['outcome_posts', 'inquiry'])
    expect(portStatus(inquiry)).toMatchObject({ inquiryMoved: true, collections: false })
    for (const ns of OUTCOME_POSTS) expect({ ns, next: nextOf(inquiry, ns) }).toEqual({ ns, next: [`output:${inquiryBodyNamespace(ns)}`] })
  })

  it('refuses to move the inquiry while any outcome post still goes to the relay', () => {
    const canary = portMainFlow(productionMainFlow(), PORT_STAGES.canary_invalid_state)
    const reasons = refusalOf(canary, { posts: ['invalid_state_sf_post'], moveInquiry: true })
    expect(reasons.join('\n')).toMatch(/inquiry.*send_salesforce/s)
  })
})

describe('refuses a definition whose ported parts are not the shape it expects', () => {
  it('a missing relay post', () => {
    const def = productionMainFlow()
    def.nodes = def.nodes.filter((n) => n.namespace !== 'amone_sf_post')
    expect(refusalOf(def).join('\n')).toMatch(/amone_sf_post/)
  })

  it('an unknown extra post to either relay', () => {
    const def = productionMainFlow()
    const copy = structuredClone(nodeByNamespace(def, 'tripoint_sf_post'))
    copy.id = '00000000-0000-4000-8000-0000000000aa'
    copy.namespace = 'tripoint_sf_post_2'
    def.nodes.push(copy)
    expect(refusalOf(def).join('\n')).toMatch(/tripoint_sf_post_2/)
  })

  it('an outcome post pointed at another URL', () => {
    const def = productionMainFlow()
    nodeByNamespace(def, 'under_10000_sf_post').config.url = 'https://example.com/hook'
    expect(refusalOf(def).join('\n')).toMatch(/under_10000_sf_post/)
  })

  it('a setting on a post the transform does not know how to carry over', () => {
    const def = productionMainFlow()
    nodeByNamespace(def, 'send_salesforce').config.headers = { 'X-Extra': '1' }
    expect(refusalOf(def).join('\n')).toMatch(/send_salesforce.*headers/)
  })

  it('a text body with no submissionId to take the record id from', () => {
    const def = productionMainFlow()
    const node = nodeByNamespace(def, 'send_fallback_salesforce')
    node.config.body = String(node.config.body).replace('"submissionId"', '"submissionRef"')
    expect(refusalOf(def).join('\n')).toMatch(/send_fallback_salesforce.*submissionId/)
  })

  it('a post with a second step after it', () => {
    const def = productionMainFlow()
    def.edges.push({ id: 'extra-edge', source: nodeByNamespace(def, 'tripoint_sf_post').id, target: nodeByNamespace(def, 'exit_1').id, source_handle: 'output' })
    expect(refusalOf(def).join('\n')).toMatch(/tripoint_sf_post/)
  })

  it('a post that no longer follows a response, so it would run before the answer', () => {
    const def = productionMainFlow()
    const post = nodeByNamespace(def, 'debt_missing_sf_post')
    const edge = def.edges.find((e) => e.target === post.id)!
    edge.source = nodeByNamespace(def, 'debt_missing_cache').id
    expect(refusalOf(def).join('\n')).toMatch(/debt_missing_sf_post/)
  })

  it('parallel_1 changed: another child', () => {
    const def = productionMainFlow()
    const p = nodeByNamespace(def, 'parallel_1')
    ;(p.config.children as unknown[]).push({ id: 'child-3', label: 'something_new' })
    expect(refusalOf(def).join('\n')).toMatch(/parallel_1/)
  })

  it('parallel_1 changed: a child-2 slot that is not the collections slot', () => {
    const def = productionMainFlow()
    ;(nodeByNamespace(def, 'parallel_1').config.children as unknown[]).push({ id: COLLECTIONS_SLOT, label: 'something_new' })
    expect(refusalOf(def, PORT_STAGES.collections).join('\n')).toMatch(/parallel_1/)
    expect(refusalOf(def, PORT_STAGES.canary_invalid_state).join('\n')).toMatch(/parallel_1/)
  })

  it('parallel_1 changed: the inquiry relay wired to another slot', () => {
    const def = productionMainFlow()
    const edge = def.edges.find((e) => e.target === nodeByNamespace(def, 'send_salesforce_inquiry').id && e.source_handle === 'child-1')!
    edge.source_handle = 'child-0'
    expect(refusalOf(def).join('\n')).toMatch(/parallel_1|send_salesforce_inquiry/)
  })

  it('the inquiry relay body changed', () => {
    const def = productionMainFlow()
    ;(nodeByNamespace(def, 'send_salesforce_inquiry').config.body as Record<string, unknown>).extra = '{{steps.x.output}}'
    expect(refusalOf(def).join('\n')).toMatch(/send_salesforce_inquiry/)
  })

  it('a step that reads what a relay post answered, which a native step answers differently', () => {
    const def = productionMainFlow()
    nodeByNamespace(def, 'achieve_tripoint_win').config.note = '{{steps.tripoint_sf_post.output.body}}'
    expect(refusalOf(def).join('\n')).toMatch(/achieve_tripoint_win.*tripoint_sf_post/)
  })

  it('a step that reads the inquiry relay, which is removed', () => {
    const def = productionMainFlow()
    nodeByNamespace(def, 'mutate_bes').config.note = '{{steps.send_salesforce_inquiry.output}}'
    expect(refusalOf(def).join('\n')).toMatch(/mutate_bes.*send_salesforce_inquiry/)
  })

  it('a step that reads parallel_1\'s output, which the collections slot adds to', () => {
    const def = live()
    nodeByNamespace(def, 'mutate_bes').config.note = '{{steps.parallel_1.output[1]}}'
    expect(refusalOf(def, PORT_STAGES.collections).join('\n')).toMatch(/mutate_bes.*parallel_1/)
  })

  it('a namespace the transform would add already taken', () => {
    const def = productionMainFlow()
    nodeByNamespace(def, 'mutate_bes').namespace = inquiryApexNamespace('tripoint_sf_post')
    expect(refusalOf(def).join('\n')).toContain(inquiryApexNamespace('tripoint_sf_post'))
  })

  it('a collections namespace already taken when the collections slot is added', () => {
    const def = live()
    nodeByNamespace(def, 'mutate_bes').namespace = COLLECTIONS_APEX
    expect(refusalOf(def, PORT_STAGES.collections).join('\n')).toContain(`${COLLECTIONS_APEX}: the namespace the port adds is already taken`)
  })

  it('no equifax_debt trades_present route for the inquiry body to read', () => {
    const def = productionMainFlow()
    const branch = nodeByNamespace(def, 'equifax_debt')
    ;(branch.config.branches as Array<{ label: string }>)[0].label = 'has_trades'
    expect(refusalOf(def).join('\n')).toMatch(/equifax_debt.*trades_present/)
  })

  it('the inquiry moved but its body and Apex call no longer follow a post', () => {
    const def = applyAll(productionMainFlow(), ['outcome_posts', 'inquiry'])
    const toApex = def.edges.find((e) => e.source === nodeByNamespace(def, inquiryBodyNamespace('send_salesforce')).id)!
    toApex.target = nodeByNamespace(def, 'mutate_bes').id
    expect(refusalOf(def, PORT_STAGES.inquiry).join('\n')).toMatch(/send_salesforce: .*inquiry body and Apex call/)
  })

  describe('a collections slot changed on the canvas, by every stage', () => {
    const withSlot = () => portMainFlow(live(), PORT_STAGES.collections)
    const stages = Object.keys(PORT_STAGES) as PortStage[]

    it.each(stages)('%s: its continue mark removed', (stage) => {
      const def = withSlot()
      const children = nodeByNamespace(def, 'parallel_1').config.children as Array<Record<string, unknown>>
      delete children.find((c) => c.id === COLLECTIONS_SLOT)!.on_failure
      expect(refusalOf(def, PORT_STAGES[stage]).join('\n')).toMatch(/parallel_1/)
    })

    it.each(stages)('%s: a step added inside the slot', (stage) => {
      const def = withSlot()
      const toApex = def.edges.find((e) => e.source === nodeByNamespace(def, COLLECTIONS_BODY).id)!
      toApex.target = nodeByNamespace(def, 'mutate_bes').id
      expect(refusalOf(def, PORT_STAGES[stage]).join('\n')).toMatch(/collections/)
    })

    it.each(stages)('%s: the Apex call pointed at another endpoint', (stage) => {
      const def = withSlot()
      nodeByNamespace(def, COLLECTIONS_APEX).config.apex_path = '/services/apexrest/credit-trades'
      expect(refusalOf(def, PORT_STAGES[stage]).join('\n')).toMatch(/collections_apex/)
    })

    it.each(stages)('%s: the slot named in parallel_1 but its steps gone', (stage) => {
      const def = withSlot()
      def.nodes = def.nodes.filter((n) => n.namespace !== COLLECTIONS_BODY && n.namespace !== COLLECTIONS_APEX)
      const ids = new Set(def.nodes.map((n) => n.id))
      def.edges = def.edges.filter((e) => ids.has(e.source) && ids.has(e.target))
      expect(refusalOf(def, PORT_STAGES[stage]).join('\n')).toMatch(/collections/)
    })
  })

  it('names every problem at once rather than the first', () => {
    const def = productionMainFlow()
    def.nodes = def.nodes.filter((n) => n.namespace !== 'amone_sf_post' && n.namespace !== 'tripoint_sf_post')
    const reasons = refusalOf(def)
    expect(reasons.some((r) => r.includes('amone_sf_post'))).toBe(true)
    expect(reasons.some((r) => r.includes('tripoint_sf_post'))).toBe(true)
  })

  it('something that is not a definition at all', () => {
    expect(refusalOf(null).join('\n')).toMatch(/definition/)
    expect(refusalOf({ nodes: 'x' }).join('\n')).toMatch(/nodes/)
  })
})
