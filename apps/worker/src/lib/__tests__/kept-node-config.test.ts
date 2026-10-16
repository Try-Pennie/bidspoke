/**
 * The outcome deciding node settings of each kept workflow against the canvas
 * mirror (#1662).
 *
 * On 2026-09-30 the Liberty1 Click Handler's click_send success line was changed
 * on the canvas (version 12) and nothing noticed the committed definition going
 * stale: the script check reads code node scripts only. These tests hold the
 * settings half: a canvas differing from the committed file ONLY in a watched
 * setting pages naming the setting and both values, a watched setting the
 * committed file lacks is its own finding, a mode an operator moves on purpose
 * is judged against its vocabulary rather than the file, and a canvas that
 * agrees says nothing.
 */
import { describe, expect, it } from 'vitest'
import { BUYER_SELECT_MODES } from '@bidspoke/buyer-profile'
import {
  UNWATCHED_CONFIG_FIELDS,
  WATCHED_CONFIG_FIELDS,
  describeConfigVerdict,
  judgeKeptConfig,
  type CommittedSource,
  type ConfigVerdict,
} from '../kept-node-config'
import { KEPT_CANVAS_WORKFLOWS, runEngineScriptDrift, endingOf } from '../engine-script-drift'
import liberty1File from '../../../../../docs/workflows/liberty1-click/definition.json'
import wiringFile from '../../../../../docs/workflows/engine-bidding/liberty1-wiring.json'
import buyerSelectFile from '../../../../../docs/workflows/engine-bidding/buyer-select.json'
import salesforceNodesFile from '../../../../../docs/workflows/engine-bidding/salesforce-nodes.json'

type NodeLike = { namespace: string; type: string; config: Record<string, unknown> }
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const LIBERTY1_NODES = (liberty1File.definition.nodes as unknown as NodeLike[])
const liberty1 = KEPT_CANVAS_WORKFLOWS.find((w) => w.folder === 'liberty1-click')!
const engine = KEPT_CANVAS_WORKFLOWS.find((w) => w.folder === 'engine-bidding')!

/** The canvas as the committed file describes it, with every kept script as the script check expects it. */
function canvasFromCommitted(nodes: readonly NodeLike[], scripts: readonly { namespace: string; script: string }[]): NodeLike[] {
  return clone(nodes).map((n) => {
    const kept = scripts.find((s) => s.namespace === n.namespace)
    return kept && n.type === 'code' ? { ...n, config: { ...n.config, script: kept.script } } : n
  })
}

const source = (nodes: NodeLike[], file = 'docs/x/definition.json'): CommittedSource => ({ file, nodes })
const node = (namespace: string, type: string, config: Record<string, unknown>): NodeLike => ({ namespace, type, config })

describe('judgeKeptConfig', () => {
  const SEND = { partner_id: 'p-1', prospect_id: '{{a}}', request_body: '{{b}}', state: '{{s}}', alert_over_percent: 120, retries: 0 }

  it('agrees when the canvas holds every watched setting the committed file holds', () => {
    const verdicts = judgeKeptConfig([source([node('click_send', 'buyer_click_send', SEND)])], { nodes: [node('click_send', 'buyer_click_send', clone(SEND))] }, 'W')
    expect(verdicts).toEqual([{ workflow: 'W', namespace: 'click_send', file: 'docs/x/definition.json', state: 'agree' }])
  })

  // #1671: the state template now picks the buyer profile's route on every click, so it is watched.
  it('a canvas differing only in the click send state template is a config drift naming the setting and both values', () => {
    const canvas = { ...SEND, state: '{{steps.other.output.state}}' }
    const verdicts = judgeKeptConfig([source([node('click_send', 'buyer_click_send', SEND)])], { nodes: [node('click_send', 'buyer_click_send', canvas)] }, 'W')
    expect(verdicts).toEqual([
      { workflow: 'W', namespace: 'click_send', file: 'docs/x/definition.json', state: 'config_drift', field: 'state', path: 'state', committed: '"{{s}}"', canvas: '"{{steps.other.output.state}}"' },
    ])
    const line = describeConfigVerdict(verdicts[0])
    expect(line).toContain('state')
    expect(line).toContain('click_send')
    expect(line).toContain('docs/x/definition.json')
    expect(line).toContain('{{s}}')
    expect(line).toContain('{{steps.other.output.state}}')
  })

  it('a click send state template removed from the canvas is a drift to (not set)', () => {
    const { state: _omit, ...canvas } = SEND
    void _omit
    const [v] = judgeKeptConfig([source([node('click_send', 'buyer_click_send', SEND)])], { nodes: [node('click_send', 'buyer_click_send', canvas)] }, 'W')
    expect(v).toMatchObject({ state: 'config_drift', field: 'state', committed: '"{{s}}"', canvas: '(not set)' })
  })

  // #1671 removed the node's own address and success line, and the live canvas was
  // cleared of both at version 15 (2026-09-30). The node never reads them, so one
  // reappearing means somebody expects it to do something: it is reported, by name.
  it('a request_url or success_pattern reappearing on the canvas is a retired setting finding naming it', () => {
    for (const [field, value] of [['request_url', '{{u}}'], ['success_pattern', 'OK (?<id>\\d+)'], ['request_url', '']] as const) {
      const verdicts = judgeKeptConfig([source([node('click_send', 'buyer_click_send', SEND)])], { nodes: [node('click_send', 'buyer_click_send', { ...SEND, [field]: value })] }, 'W')
      expect(verdicts, field).toMatchObject([{ workflow: 'W', namespace: 'click_send', file: 'docs/x/definition.json', state: 'retired_setting', field, canvas: JSON.stringify(value) }])
      expect(verdicts, field).toHaveLength(1)
      const line = describeConfigVerdict(verdicts[0])
      expect(line).toContain(field)
      expect(line).toContain('no longer reads')
      expect(line).toContain('Click delivery')
    }
  })

  it('both retired settings on the canvas are two findings, one each', () => {
    const verdicts = judgeKeptConfig([source([node('click_send', 'buyer_click_send', SEND)])], { nodes: [node('click_send', 'buyer_click_send', { ...SEND, request_url: '{{u}}', success_pattern: 'x' })] }, 'W')
    expect(verdicts.map((v) => (v.state === 'retired_setting' ? v.field : v.state)).sort()).toEqual(['request_url', 'success_pattern'])
  })

  it('names the first differing path inside a nested setting rather than the whole object', () => {
    const committed = { mode: 'live', population: 'engine', sale_payload: { base: '{{t}}', set: [{ path: 'a', template: '1' }, { path: 'b', template: '2' }] } }
    const canvas = clone(committed)
    canvas.sale_payload.set[1].template = '3'
    const [v] = judgeKeptConfig([source([node('buyer_select', 'buyer_select', committed)])], { nodes: [node('buyer_select', 'buyer_select', canvas)] }, 'W')
    expect(v).toMatchObject({ state: 'config_drift', field: 'sale_payload', path: 'sale_payload.set[1].template', committed: '"2"', canvas: '"3"' })
  })

  it('ignores key order inside a setting, which the canvas does not preserve', () => {
    const committed = { mode: 'live', sale_payload: { base: '{{t}}', set: [] as unknown[] } }
    const canvas = { mode: 'live', sale_payload: { set: [] as unknown[], base: '{{t}}' } }
    expect(judgeKeptConfig([source([node('s', 'buyer_select', committed)])], { nodes: [node('s', 'buyer_select', canvas)] }, 'W').map((v) => v.state)).toEqual(['agree'])
  })

  it('a watched setting the canvas holds and the committed file lacks is its own finding, never an agreement', () => {
    const { state: _omit, ...committed } = SEND
    void _omit
    const verdicts = judgeKeptConfig([source([node('click_send', 'buyer_click_send', committed)])], { nodes: [node('click_send', 'buyer_click_send', clone(SEND))] }, 'W')
    expect(verdicts).toEqual([
      { workflow: 'W', namespace: 'click_send', file: 'docs/x/definition.json', state: 'not_committed', field: 'state', canvas: '"{{s}}"' },
    ])
    expect(describeConfigVerdict(verdicts[0])).toContain('not in docs/x/definition.json')
  })

  it('a watched setting the committed file holds and the canvas lacks is a drift to (not set)', () => {
    const { partner_id: _omit, ...canvas } = SEND
    void _omit
    const [v] = judgeKeptConfig([source([node('click_send', 'buyer_click_send', SEND)])], { nodes: [node('click_send', 'buyer_click_send', canvas)] }, 'W')
    expect(v).toMatchObject({ state: 'config_drift', field: 'partner_id', committed: '"p-1"', canvas: '(not set)' })
  })

  it('a watched setting absent on both sides agrees: the two are configured alike', () => {
    const { request_body: _omit, ...both } = SEND
    void _omit
    expect(judgeKeptConfig([source([node('c', 'buyer_click_send', both)])], { nodes: [node('c', 'buyer_click_send', clone(both))] }, 'W').map((v) => v.state)).toEqual(['agree'])
  })

  it('an unwatched setting (an alert threshold, retries the node ignores) never pages, whatever it holds', () => {
    const canvas = { ...SEND, alert_over_percent: 150, retries: 3, daily_lead_cap: 10 }
    expect(judgeKeptConfig([source([node('c', 'buyer_click_send', SEND)])], { nodes: [node('c', 'buyer_click_send', canvas)] }, 'W').map((v) => v.state)).toEqual(['agree'])
  })

  it('buyer_select mode is judged against the allowed modes, not the committed value, so Stage B moving decide_only to live stays quiet', () => {
    const committed = { mode: 'decide_only', population: 'engine' }
    for (const mode of BUYER_SELECT_MODES) {
      expect(judgeKeptConfig([source([node('s', 'buyer_select', committed)])], { nodes: [node('s', 'buyer_select', { ...committed, mode })] }, 'W').map((v) => v.state), mode).toEqual(['agree'])
    }
  })

  it('a buyer_select mode outside the allowed modes, or none at all, pages as such', () => {
    const committed = { mode: 'live', population: 'engine' }
    const [odd] = judgeKeptConfig([source([node('s', 'buyer_select', committed)])], { nodes: [node('s', 'buyer_select', { ...committed, mode: 'Live' })] }, 'W')
    expect(odd).toMatchObject({ state: 'outside_allowed', field: 'mode', canvas: '"Live"', allowed: [...BUYER_SELECT_MODES] })
    expect(describeConfigVerdict(odd)).toContain('decide_only')
    const [none] = judgeKeptConfig([source([node('s', 'buyer_select', committed)])], { nodes: [node('s', 'buyer_select', { population: 'engine' })] }, 'W')
    expect(none).toMatchObject({ state: 'outside_allowed', field: 'mode', canvas: '(not set)' })
  })

  it('reports every differing setting on a node, one verdict each', () => {
    const canvas = { ...SEND, partner_id: 'p-2', state: 'x' }
    const verdicts = judgeKeptConfig([source([node('c', 'buyer_click_send', SEND)])], { nodes: [node('c', 'buyer_click_send', canvas)] }, 'W')
    expect(verdicts.map((v) => (v.state === 'config_drift' ? v.field : v.state)).sort()).toEqual(['partner_id', 'state'])
  })

  it('a committed node the canvas lacks is a missing node, and one of another type is a type change', () => {
    const src = source([node('click_send', 'buyer_click_send', SEND)])
    expect(judgeKeptConfig([src], { nodes: [] }, 'W')).toEqual([{ workflow: 'W', namespace: 'click_send', file: 'docs/x/definition.json', state: 'missing_node', nodeType: 'buyer_click_send' }])
    const [t] = judgeKeptConfig([src], { nodes: [node('click_send', 'code', { script: '' })] }, 'W')
    expect(t).toMatchObject({ state: 'type_changed', committedType: 'buyer_click_send', canvasType: 'code' })
  })

  it('judges only committed nodes of a type with watched settings, so a code node is left to the script check', () => {
    const src = source([node('gate', 'code', { script: 'a', retries: 2 }), node('end', 'branch_end', {})])
    expect(judgeKeptConfig([src], { nodes: [] }, 'W')).toEqual([])
  })

  it('judges each committed file against the one canvas, naming the file each node came from', () => {
    const a = source([node('route', 'branch', { branches: [], else_behavior: 'output' })], 'docs/a.json')
    const b = source([node('buyer_select', 'buyer_select', { mode: 'live', population: 'engine' })], 'docs/b.json')
    const canvas = { nodes: [node('route', 'branch', { branches: [], else_behavior: 'fail' }), node('buyer_select', 'buyer_select', { mode: 'live', population: 'engine' })] }
    const verdicts = judgeKeptConfig([a, b], canvas, 'W')
    expect(verdicts.map((v) => [v.namespace, v.file, v.state])).toEqual([['route', 'docs/a.json', 'config_drift'], ['buyer_select', 'docs/b.json', 'agree']])
  })

  it('truncates a long value rather than posting a whole template to Slack', () => {
    const long = 'x'.repeat(600)
    const [v] = judgeKeptConfig([source([node('c', 'buyer_click_send', { ...SEND, request_body: long })])], { nodes: [node('c', 'buyer_click_send', { ...SEND, request_body: `${long}y` })] }, 'W')
    expect(describeConfigVerdict(v).length).toBeLessThan(600)
  })
})

describe('the field list is a decision for every setting a kept node holds', () => {
  it('every setting on every committed node is either watched or unwatched with a reason, so a new setting cannot slip past unjudged', () => {
    const unclassified: string[] = []
    for (const w of KEPT_CANVAS_WORKFLOWS) {
      for (const s of w.configSources) {
        for (const n of s.nodes) {
          const watched = (WATCHED_CONFIG_FIELDS[n.type] ?? []).map((r) => r.field)
          const unwatched = (UNWATCHED_CONFIG_FIELDS[n.type] ?? []).map((r) => r.field)
          for (const key of Object.keys(n.config)) if (!watched.includes(key) && !unwatched.includes(key)) unclassified.push(`${s.file} ${n.namespace} (${n.type}).${key}`)
        }
      }
    }
    expect(unclassified).toEqual([])
  })

  it('every entry, watched or not, carries its reason', () => {
    for (const rules of [...Object.values(WATCHED_CONFIG_FIELDS), ...Object.values(UNWATCHED_CONFIG_FIELDS)]) {
      for (const r of rules) expect(r.why.length, r.field).toBeGreaterThan(20)
    }
  })

  it('no setting is both watched and unwatched', () => {
    for (const [type, rules] of Object.entries(WATCHED_CONFIG_FIELDS)) {
      const unwatched = (UNWATCHED_CONFIG_FIELDS[type] ?? []).map((r) => r.field)
      for (const r of rules) expect(unwatched, `${type}.${r.field}`).not.toContain(r.field)
    }
  })

  it('watches the settings #1662 names', () => {
    const fields = (type: string) => (WATCHED_CONFIG_FIELDS[type] ?? []).map((r) => r.field)
    expect(fields('buyer_click_send')).toEqual(expect.arrayContaining(['partner_id', 'prospect_id', 'request_body', 'state']))
    // #1671: the address and the success line are the buyer profile's, so the node's old copies decide nothing.
    expect(fields('buyer_click_send')).not.toContain('request_url')
    expect(fields('buyer_click_send')).not.toContain('success_pattern')
    expect(fields('buyer_click_check')).toEqual(expect.arrayContaining(['partner_id', 'population', 'state', 'debt', 'loan_amount', 'collections']))
    expect(fields('buyer_select')).toEqual(expect.arrayContaining(['mode', 'population', 'live_percent_env', 'sale_payload', 'lead_key', 'sell_off_when', 'bid_when_positive', 'state', 'debt', 'collections']))
    expect(WATCHED_CONFIG_FIELDS.buyer_select.find((r) => r.field === 'mode')?.allowed).toEqual([...BUYER_SELECT_MODES])
  })
})

describe('the committed sources the check reads', () => {
  it('Liberty1 is judged against its definition.json, every node of it', () => {
    expect(liberty1.configSources.map((s) => s.file)).toEqual(['docs/workflows/liberty1-click/definition.json'])
    expect(liberty1.configSources[0].nodes).toEqual(LIBERTY1_NODES)
  })

  describe('a Salesforce setting changed on the Liberty1 click canvas pages (#1666)', () => {
    const judge = (nodes: NodeLike[]) => judgeKeptConfig(liberty1.configSources, { nodes }, 'Liberty1 click workflow')
    const SF_NAMESPACES = ['query_record', 'update_prospect', 'update_submission', 'update_lead']

    it('the committed Liberty1 Salesforce nodes are the four writes and the lookup, and a canvas holding them agrees', () => {
      expect(LIBERTY1_NODES.filter((n) => n.type === 'salesforce').map((n) => n.namespace)).toEqual(SF_NAMESPACES)
      const verdicts = judge(clone(LIBERTY1_NODES)).filter((v) => SF_NAMESPACES.includes(v.namespace))
      expect(verdicts.map((v) => [v.namespace, v.state])).toEqual(SF_NAMESPACES.map((n) => [n, 'agree']))
    })

    const added: [string, string, unknown][] = [
      ['update_prospect', 'expected_errors', [{ code: 'DUPLICATE_VALUE', response_status: 200 }]],
      ['update_submission', 'injected_fields', { Note__c: '{{execution.trace_id}}' }],
      ['update_lead', 'external_id_field', 'LeadUUID__c'],
      ['update_lead', 'external_id_value', '{{trigger.payload.leadUuid}}'],
      ['query_record', 'apex_path', '/services/apexrest/click'],
      ['query_record', 'apex_method', 'GET'],
      // The relay port's write options (#2170) decide what is written, so they are watched.
      ['update_submission', 'omit_fields', ['executionId']],
      ['update_submission', 'rename_fields', { UUID: 'Engine_UUID_SO__c' }],
      ['update_submission', 'skip_when_empty', true],
    ]
    for (const [namespace, field, value] of added) {
      it(`${namespace} gaining ${field} on the canvas is a finding naming it, since the committed definition has none`, () => {
        const canvas = clone(LIBERTY1_NODES)
        const target = canvas.find((n) => n.namespace === namespace)!
        expect(target.config[field]).toBeUndefined()
        target.config[field] = value
        const found = judge(canvas).filter((v) => v.state !== 'agree')
        expect(found).toEqual([
          { workflow: 'Liberty1 click workflow', namespace, file: 'docs/workflows/liberty1-click/definition.json', state: 'not_committed', field, canvas: JSON.stringify(value) },
        ])
      })
    }

    const changed: [string, string, unknown][] = [
      ['update_prospect', 'record_id', '{{steps.pick_record.output.lead_id}}'],
      ['update_submission', 'object', 'Lead'],
      ['update_lead', 'body', '{{steps.click_patch.output.prospect}}'],
      ['query_record', 'soql', 'SELECT Id FROM Lead'],
    ]
    for (const [namespace, field, value] of changed) {
      it(`${namespace}.${field} changed on the canvas is a config drift naming it`, () => {
        const canvas = clone(LIBERTY1_NODES)
        canvas.find((n) => n.namespace === namespace)!.config[field] = value
        const found = judge(canvas).filter((v) => v.state !== 'agree')
        expect(found).toHaveLength(1)
        expect(found[0]).toMatchObject({ namespace, state: 'config_drift', field, path: field, canvas: JSON.stringify(value) })
      })
    }
  })

  it('Engine Bidding is judged against the #1544 wiring nodes, the committed buyer_select and its Salesforce nodes', () => {
    expect(engine.configSources.map((s) => s.file)).toEqual([
      'docs/workflows/engine-bidding/liberty1-wiring.json',
      'docs/workflows/engine-bidding/buyer-select.json',
      'docs/workflows/engine-bidding/salesforce-nodes.json',
    ])
    expect(engine.configSources[0].nodes).toEqual(wiringFile.add_nodes)
    expect(engine.configSources[1].nodes).toEqual(buyerSelectFile.nodes)
    expect(engine.configSources[2].nodes).toEqual(salesforceNodesFile.nodes)
    const namespaces = engine.configSources.flatMap((s) => s.nodes).filter((n) => (WATCHED_CONFIG_FIELDS[n.type] ?? []).length > 0).map((n) => n.namespace)
    expect(namespaces).toEqual(['route_known_no', 'buyer_click_check', 'buyer_select', 'create_prospect', 'prospect_trades', 'patch_prospect', 'patch_prospect_reject'])
  })

  it('the committed Salesforce nodes are every salesforce node of version 104, as the canvas holds them (#1666)', () => {
    expect(salesforceNodesFile.version).toBe(104)
    expect(salesforceNodesFile.nodes.map((n) => n.type)).toEqual(['salesforce', 'salesforce', 'salesforce', 'salesforce'])
    const patch = salesforceNodesFile.nodes.find((n) => n.namespace === 'patch_prospect')!
    expect(patch.config).toMatchObject({ operation: 'update', object: 'Prospect__c', record_id: '{{steps.generate_trades_body.output.prospectId}}', body: '{{steps.patch_prospect_body.output}}' })
  })

  describe('a Salesforce write changed on the Engine canvas pages (#1666)', () => {
    const sfSource = engine.configSources.find((s) => s.file.endsWith('salesforce-nodes.json'))!
    const sfNodes = () => clone(sfSource.nodes) as NodeLike[]
    const judge = (nodes: NodeLike[]) => judgeKeptConfig([sfSource], { nodes }, 'Engine Bidding Workflow')

    it('agrees when the canvas holds the committed Salesforce nodes', () => {
      expect(judge(sfNodes()).map((v) => [v.namespace, v.state])).toEqual([
        ['create_prospect', 'agree'], ['prospect_trades', 'agree'], ['patch_prospect', 'agree'], ['patch_prospect_reject', 'agree'],
      ])
    })

    const cases: [string, string, unknown][] = [
      ['patch_prospect', 'record_id', '{{steps.other.output.id}}'],
      ['patch_prospect', 'object', 'Lead'],
      ['patch_prospect', 'body', '{{steps.build_response_body.output}}'],
      ['patch_prospect_reject', 'operation', 'upsert'],
      ['create_prospect', 'injected_fields', { ProspectTraceId__c: '{{execution.trace_id}}' }],
      ['create_prospect', 'expected_errors', []],
      ['prospect_trades', 'apex_path', '/services/apexrest/prospect-trades-v2'],
    ]
    for (const [namespace, field, value] of cases) {
      it(`${namespace}.${field} changed on the canvas is a config drift naming it`, () => {
        const canvas = sfNodes()
        canvas.find((n) => n.namespace === namespace)!.config[field] = value
        const found = judge(canvas).filter((v) => v.state !== 'agree')
        expect(found).toHaveLength(1)
        expect(found[0]).toMatchObject({ namespace, state: 'config_drift', field, file: 'docs/workflows/engine-bidding/salesforce-nodes.json' })
      })
    }

    it('a timeout or retry tuned on the canvas is not a finding', () => {
      const canvas = sfNodes()
      for (const n of canvas) Object.assign(n.config, { timeout_ms: 99, retries: 5, transient_errors: [] })
      expect(judge(canvas).every((v) => v.state === 'agree')).toBe(true)
    })
  })

  it('both committed files name the Liberty1 partner the canvas picked (partner_configs 4ed89cc6..., slug liberty1, read 2026-09-30)', () => {
    const LIBERTY1 = '4ed89cc6-b25b-4537-8b3d-5bf1fc237cc3'
    expect(LIBERTY1_NODES.find((n) => n.type === 'buyer_click_send')?.config.partner_id).toBe(LIBERTY1)
    expect((wiringFile.add_nodes as unknown as NodeLike[]).find((n) => n.type === 'buyer_click_check')?.config.partner_id).toBe(LIBERTY1)
  })
})

describe('config findings travel in the script check run and its one alert', () => {
  const mirrorOf = (nodes: NodeLike[]) => (async () => new Response(JSON.stringify({ definition: { nodes } }), { status: 200 })) as unknown as typeof fetch
  const run = (workflow: typeof liberty1, nodes: NodeLike[]) =>
    runEngineScriptDrift({ repo: 'Try-Pennie/bidspoke-workflows', token: 'tok', workflows: [workflow], fetch: mirrorOf(nodes), localDev: false, log: () => {} })

  it('a Liberty1 canvas that is the committed definition, with the kept scripts, has no findings', async () => {
    const s = await run(liberty1, canvasFromCommitted(LIBERTY1_NODES, liberty1.scripts))
    expect(s.findings).toEqual([])
    expect(s.configVerdicts.length).toBeGreaterThan(10)
    expect(new Set(s.configVerdicts.map((v) => v.state))).toEqual(new Set(['agree']))
    expect(endingOf(s)).toMatchObject({ outcome: 'ok', summary: { config: { 'Liberty1 click workflow/click_send': 'agree' } } })
  })

  it('the committed click_send holds the state template the live canvas gained at version 14 (#1671)', () => {
    const send = LIBERTY1_NODES.find((n) => n.namespace === 'click_send')!
    expect(send.config.state).toBe('{{steps.build_request.output.state}}')
    expect(send.config).not.toHaveProperty('request_url')
    expect(send.config).not.toHaveProperty('success_pattern')
  })

  it('the same canvas with only click_send.state changed pages once, naming the setting and both values', async () => {
    const canvas = canvasFromCommitted(LIBERTY1_NODES, liberty1.scripts)
    const send = canvas.find((n) => n.namespace === 'click_send')!
    send.config.state = '{{trigger.payload.state}}'
    const s = await run(liberty1, canvas)
    expect(s.verdicts.every((v) => v.state === 'agree')).toBe(true)
    expect(s.findings).toHaveLength(1)
    expect(s.findings[0]).toContain('Liberty1 click workflow, click_send')
    expect(s.findings[0]).toContain('state')
    expect(s.findings[0]).toContain('{{steps.build_request.output.state}}')
    expect(s.findings[0]).toContain('{{trigger.payload.state}}')
    expect(endingOf(s)).toMatchObject({ outcome: 'findings', summary: { config: { 'Liberty1 click workflow/click_send': 'config_drift' } } })
  })

  it('an Engine canvas holding the committed nodes, with buyer_select in either mode, has no config findings', async () => {
    const committed = engine.configSources.flatMap((s) => s.nodes) as NodeLike[]
    for (const mode of BUYER_SELECT_MODES) {
      const canvas = canvasFromCommitted(committed, engine.scripts).map((n) => (n.type === 'buyer_select' ? { ...n, config: { ...n.config, mode } } : n))
      const s = await run(engine, canvas)
      expect(s.configVerdicts.map((v: ConfigVerdict) => v.state), mode).toEqual(Array(7).fill('agree'))
    }
  })

  it('an unreadable mirror judges no settings either', async () => {
    const s = await runEngineScriptDrift({
      repo: 'r', token: 't', workflows: [liberty1], localDev: false, log: () => {}, fetch: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
    })
    expect(s.configVerdicts).toEqual([])
    expect(s.findings).toHaveLength(1)
  })
})
