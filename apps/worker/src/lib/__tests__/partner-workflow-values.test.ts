/**
 * The workflow values scanner (#2142): which workflows read a partner's values
 * from the Constants node, matched only as an access to the node's output.
 */
import { describe, it, expect, vi } from 'vitest'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text; there is no
// ambient declaration for it in this package.
import ENGINE_FIXTURE_RAW from '../../../money-gate/fixtures/definitions/da82a183-1a4a-417e-b0b8-5f3fe5e14840.json?raw'
// @ts-expect-error As above.
import LIVE_FIXTURE_RAW from './fixtures/workflow-values-live.json?raw'
import {
  partnerValueNames,
  scanPartnerValueReaders,
  type PartnerValueReaders,
  type ScannableWorkflow,
  type ScanPartner,
} from '../partner-workflow-values'
import { executeConstantsNode } from '../../engine/nodes/constants'
import type { PartnerConstants } from '../partner-constants-loader'
import type { ExecutionContext, NodeDefinition } from '../../types'
import type { Env } from '../../index'
import { summarize, type LiveFixture } from './fixtures/workflow-values-live-shape'

vi.mock('../partner-constants-loader', () => ({ loadPartnerConstants: vi.fn() }))
import { loadPartnerConstants } from '../partner-constants-loader'

const TRIPOINT: ScanPartner = { slug: 'tripoint', subAccountIds: ['uuid-tp-1'] }
const SOFI: ScanPartner = { slug: 'sofi', subAccountIds: ['uuid-sofi-1', 'uuid-sofi-2'] }

const constantsNode = (data: Record<string, unknown> = { pennieClickUrl: 'x' }) => ({ id: 'n-const', namespace: 'constants', type: 'constants', config: { data } })
const code = (namespace: string, script: string) => ({ id: `n-${namespace}`, namespace, label: namespace, type: 'code', config: { script } })

function wf(id: string, nodes: unknown[], opts: { is_active?: boolean; edges?: unknown[] } = {}): ScannableWorkflow {
  return { id, name: `Workflow ${id}`, is_active: opts.is_active ?? true, definition: { nodes, edges: opts.edges ?? [] } }
}

/** The scan of one workflow carrying a Constants node and one Code node with this script. */
function scanScript(script: string, partner: ScanPartner = TRIPOINT, extraNodes: unknown[] = []): PartnerValueReaders[] {
  return scanPartnerValueReaders([wf('w', [constantsNode(), code('reader', script), ...extraNodes])], partner)
}
const value = (scan: PartnerValueReaders[], key: string) => {
  const v = scan.find((s) => s.key === key)
  if (!v) throw new Error(`no value ${key} in the scan`)
  return v
}
const readsOf = (scan: PartnerValueReaders[], key: string) => value(scan, key).readers.map((r) => r.reads)

describe('partnerValueNames', () => {
  it('names every value the Constants node can emit for the partner, in the form the mirror reads it', () => {
    expect(partnerValueNames('tripoint').map((v) => [v.key, v.kind, v.map, v.access.template, v.access.code])).toEqual([
      ['TripointClickUrl', 'ClickUrl', false, 'steps.constants.output.TripointClickUrl', 'constants.TripointClickUrl'],
      ['TripointSellOffOfferTitle', 'SellOffOfferTitle', false, 'steps.constants.output.TripointSellOffOfferTitle', 'constants.TripointSellOffOfferTitle'],
      ['TripointSellOffOfferDetails', 'SellOffOfferDetails', false, 'steps.constants.output.TripointSellOffOfferDetails', 'constants.TripointSellOffOfferDetails'],
      ['TripointSubAccountMinBids', 'SubAccountMinBids', false, 'steps.constants.output.TripointSubAccountMinBids', 'constants.TripointSubAccountMinBids'],
      ['subAccountIdsMap', 'subAccountIdsMap', true, 'steps.constants.output.subAccountIdsMap', 'constants.subAccountIdsMap'],
      ['activeBidding', 'activeBidding', true, 'steps.constants.output.activeBidding', 'constants.activeBidding'],
    ])
  })

  it('a slug that is not an identifier is read by element access', () => {
    expect(partnerValueNames('amone-direct')[0].access).toEqual({ template: "steps.constants.output['Amone-directClickUrl']", code: "constants['Amone-directClickUrl']" })
  })

  it('searches for every partner derived key the executor emits (a key added there without the scanner fails here)', async () => {
    const data: PartnerConstants = {
      subAccountIdsMap: { 'uuid-tp-1': 'tripoint', 'uuid-sofi-1': 'sofi' },
      activeBidding: { tripoint: true, sofi: true },
      sellOff: { tripoint: { title: 'a', details: 'b' }, sofi: { title: 'c', details: 'd' } },
      clickUrls: { tripoint: 'https://a', sofi: 'https://b' },
      subAccountMinBids: { tripoint: { 'uuid-tp-1': 3 }, sofi: { 'uuid-sofi-1': 4 } },
      slugsById: { p1: 'tripoint', p2: 'sofi' },
    }
    vi.mocked(loadPartnerConstants).mockResolvedValue(data)
    const workflowData = { pennieClickUrl: 'https://trypennie.com' }
    const node = { id: 'n', namespace: 'constants', type: 'constants', config: { data: workflowData } } as NodeDefinition
    const ctx = { trigger: { org_id: 'org' }, steps: {}, env: {} } as unknown as ExecutionContext
    const { output } = await executeConstantsNode(node, ctx, {} as Env, {} as never)
    const searched = new Set(['tripoint', 'sofi'].flatMap((slug) => partnerValueNames(slug).map((v) => v.key)))
    const emitted = Object.keys(output as Record<string, unknown>).filter((k) => !(k in workflowData))
    expect(emitted.filter((k) => !searched.has(k))).toEqual([])
  })
})

describe('scanPartnerValueReaders: reads by name', () => {
  it.each([
    ['a template path', '{{steps.constants.output.TripointClickUrl}}'],
    ['optional chaining on the path', 'const u = steps.constants?.output?.TripointClickUrl'],
    ['the conventional local name', 'const constants = steps.constants.output;\nreturn constants.TripointClickUrl'],
    ['element access', "return constants['TripointClickUrl']"],
    ['any local name for the output', 'const c = steps.constants.output ?? {}\nreturn c.TripointClickUrl'],
    ['a destructure from the output', 'const { TripointClickUrl: url, other } = steps.constants.output'],
    ['a destructure from the local name', 'const { TripointClickUrl } = constants'],
  ])('%s', (_name, script) => {
    expect(readsOf(scanScript(script), 'TripointClickUrl')).toEqual(['by_name'])
  })

  it('a per slug map is read by name, an entry of it included', () => {
    expect(readsOf(scanScript('const floor = constants.TripointSubAccountMinBids?.[subAccountUuid];'), 'TripointSubAccountMinBids')).toEqual(['by_name'])
  })

  it('reports each place in the workflow that reads it, by node', () => {
    const scan = scanPartnerValueReaders(
      [wf('w', [constantsNode(), code('a', 'constants.TripointClickUrl'), code('b', 'steps.constants.output.TripointClickUrl'), code('c', 'nothing')])],
      TRIPOINT
    )
    const reader = value(scan, 'TripointClickUrl').readers[0]
    expect(reader.places.map((p) => [p.namespace, p.node_type, p.reads])).toEqual([['a', 'code', 'by_name'], ['b', 'code', 'by_name']])
  })

  it('an edge condition reading it is a place, by edge', () => {
    const scan = scanPartnerValueReaders(
      [wf('w', [constantsNode()], { edges: [{ id: 'e1', source: 'a', target: 'b', condition: { groups: [{ conditions: [{ field: 'steps.constants.output.activeBidding.tripoint', operator: 'is_true' }] }] } }] })],
      TRIPOINT
    )
    expect(value(scan, 'activeBidding').readers[0].places).toEqual([{ node_id: null, namespace: null, label: null, node_type: null, edge_id: 'e1', reads: 'by_name' }])
  })
})

describe('scanPartnerValueReaders: what is not a read', () => {
  it.each([
    ['a bare word', 'const TripointClickUrl = 1'],
    ['a property of another object', 'return pt.TripointClickUrl'],
    ['a longer name', 'return constants.TripointClickUrlOld'],
    ['another step', 'return steps.other.output.TripointClickUrl'],
    ['the wrong path', 'return steps.constants.TripointClickUrl'],
    ['a different case', 'return constants.tripointClickUrl'],
  ])('%s', (_name, script) => {
    expect(value(scanScript(script), 'TripointClickUrl').readers).toEqual([])
  })

  it('a local sellOff is never a read of a sell off value (pt.sellOff in build_response_body)', () => {
    const scan = scanScript('const sellOff = pt.sellOff;\nif (!pt.sellOff || pt.engineBid === 0) {}', SOFI)
    expect(scan.flatMap((v) => v.readers)).toEqual([])
  })

  it('a workflow with no Constants node reads nothing, whatever its scripts say', () => {
    const scan = scanPartnerValueReaders([wf('w', [code('reader', 'constants.TripointClickUrl')])], TRIPOINT)
    expect(scan.flatMap((v) => v.readers)).toEqual([])
  })

  it("the Constants node's own data is not a read", () => {
    const scan = scanPartnerValueReaders([wf('w', [constantsNode({ note: 'constants.TripointClickUrl' })])], TRIPOINT)
    expect(value(scan, 'TripointClickUrl').readers).toEqual([])
  })
})

describe('scanPartnerValueReaders: the two maps', () => {
  it.each([
    ['a computed entry', 'if (!steps.constants.output.activeBidding[sourceName]) return'],
    ['the map whole', 'const ab = constants.activeBidding ?? {}'],
    ['a destructure', 'const { activeBidding } = constants'],
  ])('activeBidding by %s reads it for every partner', (_name, script) => {
    expect(readsOf(scanScript(script), 'activeBidding')).toEqual(['every_partner'])
  })

  it("a literal entry reads that partner's entry only", () => {
    expect(readsOf(scanScript('constants.activeBidding.tripoint'), 'activeBidding')).toEqual(['by_name'])
    expect(readsOf(scanScript("constants.activeBidding['tripoint']"), 'activeBidding')).toEqual(['by_name'])
    expect(readsOf(scanScript('constants.activeBidding.sofi'), 'activeBidding')).toEqual([])
  })

  it('subAccountIdsMap is keyed by sub-account id, so a literal entry is this partner only when the id is one of its own', () => {
    expect(readsOf(scanScript("constants.subAccountIdsMap['uuid-tp-1']"), 'subAccountIdsMap')).toEqual(['by_name'])
    expect(readsOf(scanScript("constants.subAccountIdsMap['uuid-sofi-1']"), 'subAccountIdsMap')).toEqual([])
    expect(readsOf(scanScript('Object.keys(constants.subAccountIdsMap).includes(id)'), 'subAccountIdsMap')).toEqual(['every_partner'])
    expect(readsOf(scanScript('steps.constants.output.subAccountIdsMap[source]'), 'subAccountIdsMap')).toEqual(['every_partner'])
  })

  it('a method call on the map is not a literal entry', () => {
    expect(readsOf(scanScript('constants.activeBidding.hasOwnProperty(slug)'), 'activeBidding')).toEqual(['every_partner'])
  })
})

describe('scanPartnerValueReaders: the whole output read at once', () => {
  it.each([
    ['a computed name', 'return constants[name]'],
    ['Object.keys', 'for (const k of Object.keys(steps.constants.output)) {}'],
    ['a spread', 'const all = { ...constants }'],
    ['a destructure with a rest', 'const { pennieClickUrl, ...rest } = constants'],
  ])('%s reads every value, for every partner', (_name, script) => {
    const scan = scanScript(script)
    expect(scan.map((v) => v.readers.map((r) => r.reads))).toEqual(scan.map(() => ['every_partner']))
  })

  it('a literal element access is not a computed name', () => {
    expect(value(scanScript("return constants['pennieClickUrl']"), 'TripointClickUrl').readers).toEqual([])
  })
})

describe('scanPartnerValueReaders: workflows', () => {
  it('scans inactive workflows and says so', () => {
    const scan = scanPartnerValueReaders([wf('draft', [constantsNode(), code('r', 'constants.TripointClickUrl')], { is_active: false })], TRIPOINT)
    expect(value(scan, 'TripointClickUrl').readers.map((r) => [r.workflow_id, r.is_active])).toEqual([['draft', false]])
  })

  it('a workflow reading by name and for every partner reads by name', () => {
    const scan = scanScript('constants.activeBidding.tripoint\nconstants.activeBidding[slug]')
    const reader = value(scan, 'activeBidding').readers[0]
    expect(reader.reads).toBe('by_name')
    expect(reader.places[0].reads).toBe('by_name')
  })

  it('a workflow data key with a partner key name is reported as shadowed', () => {
    const scan = scanPartnerValueReaders([wf('w', [constantsNode({ TripointClickUrl: 'stale', activeBidding: {} })])], TRIPOINT)
    expect(value(scan, 'TripointClickUrl').shadowed_data_keys).toEqual([{ workflow_id: 'w', workflow_name: 'Workflow w', is_active: true, node_id: 'n-const', namespace: 'constants' }])
    expect(value(scan, 'activeBidding').shadowed_data_keys).toHaveLength(1)
    expect(value(scan, 'TripointSellOffOfferTitle').shadowed_data_keys).toEqual([])
  })

  it('a definition with no nodes or a malformed one reads nothing rather than throwing', () => {
    const scan = scanPartnerValueReaders([{ id: 'x', name: 'x', is_active: true, definition: null }, { id: 'y', name: 'y', is_active: true, definition: { nodes: 'no' } }], TRIPOINT)
    expect(scan.flatMap((v) => v.readers)).toEqual([])
  })
})

describe('positive control: the money gate fixture of Engine Bidding (da82a183)', () => {
  const fixture = JSON.parse(ENGINE_FIXTURE_RAW as string) as { id: string; name: string; definition: unknown }
  const engine: ScannableWorkflow = { id: fixture.id, name: fixture.name, is_active: true, definition: fixture.definition }
  const places = (scan: PartnerValueReaders[], key: string) =>
    value(scan, key).readers.flatMap((r) => r.places.map((p) => `${p.namespace} ${p.reads}`))

  it('reads activeBidding and subAccountIdsMap for every partner, and TripointClickUrl by name', () => {
    const scan = scanPartnerValueReaders([engine], TRIPOINT)
    expect(places(scan, 'activeBidding')).toEqual(['validate_bidding_and_state every_partner'])
    expect(places(scan, 'subAccountIdsMap')).toEqual(['validate_bidding_and_state every_partner', 'build_response_body every_partner'])
    expect(places(scan, 'TripointClickUrl')).toEqual(['build_response_body by_name', 'tripoint_ping by_name'])
    expect(value(scan, 'TripointSellOffOfferTitle').readers).toEqual([])
  })

  it("reads Sofi's sell off offer by name, and pt.sellOff matches nothing", () => {
    const scan = scanPartnerValueReaders([engine], SOFI)
    expect(places(scan, 'SofiSellOffOfferTitle')).toEqual(['build_response_body by_name'])
    expect(places(scan, 'SofiSellOffOfferDetails')).toEqual(['build_response_body by_name'])
    expect(value(scan, 'SofiClickUrl').readers).toEqual([])
    expect(value(scan, 'SofiSubAccountMinBids').readers).toEqual([])
  })
})

describe('the live definitions (measured fixture, scripts/measure-workflow-values-fixture.ts)', () => {
  const live = JSON.parse(LIVE_FIXTURE_RAW as string) as LiveFixture

  it('the reduced copy gives the answer the full definitions gave, for every partner', () => {
    for (const partner of live.partners) {
      expect(summarize(scanPartnerValueReaders(live.workflows, partner)), partner.slug).toEqual(live.expected[partner.slug])
    }
  })

  it('records the readers the issue names: Engine Bidding reads the maps and Tripoint and Sofi by name, the rate table workflows their floors', () => {
    const readersOf = (slug: string, key: string) => live.expected[slug].find((v) => v.key === key)?.readers.map((r) => `${r.workflow_id} ${r.reads}`) ?? []
    const engine = 'da82a183-1a4a-417e-b0b8-5f3fe5e14840'
    expect(readersOf('tripoint', 'TripointClickUrl')).toContain(`${engine} by_name`)
    expect(readersOf('sofi', 'SofiSellOffOfferTitle')).toContain(`${engine} by_name`)
    expect(readersOf('sofi', 'activeBidding')).toContain(`${engine} every_partner`)
    expect(readersOf('gigfi', 'GigfiSubAccountMinBids')).toEqual(['6624acd0-bf61-4d21-85fc-4371ca7ed77d by_name'])
    expect(readersOf('liberty1', 'Liberty1ClickUrl')).toEqual([])
  })
})
