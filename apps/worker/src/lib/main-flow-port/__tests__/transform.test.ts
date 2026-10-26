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
import {
  OUTCOME_POSTS,
  PORT_STAGES,
  MainFlowPortRefusal,
  COLLECTIONS_APEX_PATH,
  INQUIRY_APEX_PATH,
  collectionsApexNamespace,
  collectionsBodyNamespace,
  creditPostsEndNamespace,
  creditPostsNamespace,
  inquiryApexNamespace,
  inquiryBodyNamespace,
  portMainFlow,
  portStatus,
  type Definition,
  type PortOptions,
} from '../transform'
import { nextOf, nodeByNamespace, productionMainFlow, relayUrls } from './production-fixture'

/** Everything the port does: every stage, the collections post (#2832) last. */
const FULL = PORT_STAGES.collections

function refusalOf(def: unknown, options: PortOptions = FULL): string[] {
  try {
    portMainFlow(def, options)
  } catch (err) {
    if (err instanceof MainFlowPortRefusal) return err.reasons
    throw err
  }
  throw new Error('the transform did not refuse')
}

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

  it('drops the inquiry relay from parallel_1 and leaves the trades chain alone', () => {
    const ported = portMainFlow(productionMainFlow(), FULL)
    expect(ported.nodes.some((n) => n.namespace === 'send_salesforce_inquiry')).toBe(false)
    expect(nodeByNamespace(ported, 'parallel_1').config.children).toEqual([{ id: 'child-0', label: 'pennie_debt_calc' }])
    expect(nextOf(ported, 'parallel_1').sort()).toEqual(['child-0:trades_body', 'output:parallel_end_1'])
  })

  it('puts a credit posts block straight after every outcome write, the inquiry and collections pairs side by side, before what followed it', () => {
    const before = productionMainFlow()
    const ported = portMainFlow(before, FULL)
    for (const ns of OUTCOME_POSTS) {
      const after = nextOf(before, ns)
      const block = creditPostsNamespace(ns)
      const end = creditPostsEndNamespace(ns)
      expect({ ns, next: nextOf(ported, ns) }).toEqual({ ns, next: [`output:${block}`] })
      expect({ ns, next: nextOf(ported, block).sort() }).toEqual({ ns, next: [`child-0:${inquiryBodyNamespace(ns)}`, `child-1:${collectionsBodyNamespace(ns)}`, `output:${end}`] })
      expect({ ns, next: nextOf(ported, inquiryBodyNamespace(ns)) }).toEqual({ ns, next: [`output:${inquiryApexNamespace(ns)}`] })
      expect({ ns, next: nextOf(ported, inquiryApexNamespace(ns)) }).toEqual({ ns, next: [`output:${end}`] })
      expect({ ns, next: nextOf(ported, collectionsBodyNamespace(ns)) }).toEqual({ ns, next: [`output:${collectionsApexNamespace(ns)}`] })
      expect({ ns, next: nextOf(ported, collectionsApexNamespace(ns)) }).toEqual({ ns, next: [`output:${end}`] })
      expect({ ns, next: nextOf(ported, end) }).toEqual({ ns, next: after })
    }
  })

  it('the block fails on the inquiry slot and never on the collections slot, and waits for both', () => {
    const ported = portMainFlow(productionMainFlow(), FULL)
    for (const ns of OUTCOME_POSTS) {
      expect({ ns, config: nodeByNamespace(ported, creditPostsNamespace(ns)).config }).toEqual({ ns, config: {
        wait_for: 'all', on_child_error: 'fail', on_timeout: 'partial', timeout_ms: 5_500,
        children: [{ id: 'child-0', label: 'inquiry' }, { id: 'child-1', label: 'collections', on_failure: 'continue' }],
      } })
      expect({ ns, apex: nodeByNamespace(ported, collectionsApexNamespace(ns)).config }).toEqual({ ns, apex: {
        operation: 'apex', apex_path: COLLECTIONS_APEX_PATH, body: `{{steps.${collectionsBodyNamespace(ns)}.output}}`, skip_when_empty: true, retries: 0, timeout_ms: 4_500,
      } })
      expect(nodeByNamespace(ported, inquiryApexNamespace(ns)).config.apex_path).toBe(INQUIRY_APEX_PATH)
    }
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

  it('touches nothing but the posts, the inquiry relay and the nodes it adds', () => {
    const before = productionMainFlow()
    const ported = portMainFlow(before, FULL)
    const touched = new Set<string>([...OUTCOME_POSTS, 'parallel_1', 'send_salesforce_inquiry', ...OUTCOME_POSTS.flatMap((p) => [
      creditPostsNamespace(p), creditPostsEndNamespace(p), inquiryBodyNamespace(p), inquiryApexNamespace(p), collectionsBodyNamespace(p), collectionsApexNamespace(p),
    ])])
    const untouched = (d: Definition) => d.nodes.filter((n) => !touched.has(n.namespace))
    expect(untouched(ported)).toEqual(untouched(before))
    expect(ported.trigger).toEqual(before.trigger)
  })
})

describe('stages', () => {
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

  it('each stage builds on the one before to the same result as porting at once', () => {
    let def = productionMainFlow()
    for (const stage of Object.values(PORT_STAGES)) def = portMainFlow(def, stage)
    expect(def).toEqual(portMainFlow(productionMainFlow(), FULL))
  })

  it('applying a stage twice changes nothing the second time', () => {
    for (const stage of Object.values(PORT_STAGES)) {
      const once = portMainFlow(productionMainFlow(), stage)
      expect(portMainFlow(once, stage)).toEqual(once)
    }
  })

  it('the inquiry stage builds the block with the inquiry slot alone, and the collections stage adds the second slot over it', () => {
    const inquiry = portMainFlow(productionMainFlow(), PORT_STAGES.inquiry)
    expect(portStatus(inquiry)).toMatchObject({ inquiryMoved: true, collections: false })
    for (const ns of OUTCOME_POSTS) {
      expect(nodeByNamespace(inquiry, creditPostsNamespace(ns)).config.children).toEqual([{ id: 'child-0', label: 'inquiry' }])
      expect(inquiry.nodes.some((n) => n.namespace === collectionsApexNamespace(ns))).toBe(false)
    }
    const collections = portMainFlow(inquiry, PORT_STAGES.collections)
    expect(portStatus(collections)).toMatchObject({ inquiryMoved: true, collections: true })
    const added = collections.nodes.filter((n) => !inquiry.nodes.some((m) => m.id === n.id)).map((n) => n.namespace).sort()
    expect(added).toEqual(OUTCOME_POSTS.flatMap((p) => [collectionsBodyNamespace(p), collectionsApexNamespace(p)]).sort())
  })

  it('a stage before collections leaves a definition holding the collections steps exactly as it is', () => {
    const collections = portMainFlow(productionMainFlow(), PORT_STAGES.collections)
    for (const stage of [PORT_STAGES.canary_invalid_state, PORT_STAGES.canary_send_salesforce, PORT_STAGES.outcome_posts, PORT_STAGES.inquiry]) {
      expect(portMainFlow(collections, stage)).toEqual(collections)
    }
  })

  it('refuses the collections post without moving the inquiry, which it rides beside', () => {
    const posts = portMainFlow(productionMainFlow(), PORT_STAGES.outcome_posts)
    expect(refusalOf(posts, { posts: 'all', moveInquiry: false, collections: true }).join('\n')).toMatch(/collections.*moving the inquiry/)
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
    ;(p.config.children as unknown[]).push({ id: 'child-2', label: 'something_new' })
    expect(refusalOf(def).join('\n')).toMatch(/parallel_1/)
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

  it('a namespace the transform would add already taken', () => {
    const def = productionMainFlow()
    nodeByNamespace(def, 'mutate_bes').namespace = inquiryApexNamespace('tripoint_sf_post')
    expect(refusalOf(def).join('\n')).toContain(inquiryApexNamespace('tripoint_sf_post'))
  })

  it('no equifax_debt trades_present route for the inquiry body to read', () => {
    const def = productionMainFlow()
    const branch = nodeByNamespace(def, 'equifax_debt')
    ;(branch.config.branches as Array<{ label: string }>)[0].label = 'has_trades'
    expect(refusalOf(def).join('\n')).toMatch(/equifax_debt.*trades_present/)
  })

  it('a credit posts block whose settings changed on the canvas', () => {
    const def = portMainFlow(productionMainFlow(), PORT_STAGES.inquiry)
    nodeByNamespace(def, creditPostsNamespace('amone_sf_post')).config.on_child_error = 'continue'
    expect(refusalOf(def).join('\n')).toMatch(/credit_posts_amone_sf_post: its settings/)
  })

  it('a credit posts block with a step added inside a slot', () => {
    const def = portMainFlow(productionMainFlow(), PORT_STAGES.inquiry)
    const toApex = def.edges.find((e) => e.source === nodeByNamespace(def, inquiryBodyNamespace('send_salesforce')).id)!
    toApex.target = nodeByNamespace(def, 'mutate_bes').id
    expect(refusalOf(def).join('\n')).toMatch(/credit_posts_send_salesforce: its child-0 slot/)
  })

  it('a collections namespace already taken when the collections post is added', () => {
    const def = portMainFlow(productionMainFlow(), PORT_STAGES.inquiry)
    nodeByNamespace(def, 'mutate_bes').namespace = collectionsApexNamespace('tripoint_sf_post')
    expect(refusalOf(def).join('\n')).toContain(`${collectionsApexNamespace('tripoint_sf_post')}: the namespace the port adds is already taken`)
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
