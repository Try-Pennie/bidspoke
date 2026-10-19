/**
 * The kept Engine scripts against the canvas mirror (#1472).
 *
 * apps/worker/src/engine/scripts/engine-bidding/*.js are byte for byte what is
 * pasted into the Engine Bidding Workflow's code nodes, and the canvas is the
 * source of truth. Until the Phase 7 paste the kept copies are deliberately
 * AHEAD of the canvas, so "differs" alone would page for weeks (L36). The check
 * therefore tells three states apart per script (L11): the two agree; the
 * canvas still holds exactly the script the kept copy was derived from, so the
 * paste is awaited; or the canvas holds something that is neither, which is an
 * edit nobody mirrored back and the one thing that pages.
 */
import { describe, expect, it, vi } from 'vitest'
import { stripTrailingWhitespace } from '@bidspoke/script-hygiene'
import {
  KEPT_CANVAS_WORKFLOWS,
  KEPT_ENGINE_SCRIPTS,
  LIBERTY1_CLICK_WORKFLOW_ID,
  ENGINE_BIDDING_WORKFLOW_ID,
  ENGINE_SCRIPT_DRIFT_JOB,
  ENGINE_SCRIPT_DRIFT_UNREADABLE_REMEDY,
  driftRemedyFor,
  describeVerdict,
  endingOf,
  judgeKeptScripts,
  readMirrorDefinition,
  runEngineScriptDrift,
  runEngineScriptDriftAndPage,
  sha256Hex,
  type DriftDeps,
  type DriftSummary,
  type KeptScript,
} from '../engine-script-drift'
// The same three files through Vite's own raw loader, a path the text plugin
// does not touch (its id test excludes a query), so the two readings are
// independent and their agreement proves the plugin serves the file's bytes.
// @ts-expect-error Vite resolves the ?raw suffix to the file's text; there is no declaration for it.
import TRIPOINT_PING_RAW from '../../engine/scripts/engine-bidding/tripoint_ping.js?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import BUILD_RESPONSE_BODY_RAW from '../../engine/scripts/engine-bidding/build_response_body.js?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import PATCH_PROSPECT_BODY_RAW from '../../engine/scripts/engine-bidding/patch_prospect_body.js?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import KNOWN_NO_GATE_RAW from '../../engine/scripts/engine-bidding/known_no_gate.js?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import RESOLVE_CLICK_INPUT_RAW from '../../engine/scripts/liberty1-click/resolve_click_input.js?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import BUILD_LIBERTY1_REQUEST_RAW from '../../engine/scripts/liberty1-click/build_liberty1_request.js?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import LIBERTY1_CLICK_PATCH_RAW from '../../engine/scripts/liberty1-click/liberty1_click_patch.js?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import PICK_CLICK_RECORD_RAW from '../../engine/scripts/liberty1-click/pick_click_record.js?raw'
import liberty1File from '../../../../../docs/workflows/liberty1-click/definition.json'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import BUILD_REQUEST_V14_RAW from './fixtures/build_liberty1_request.canvas-v14.txt?raw'
/** The build_request script on the Liberty1 Click Handler canvas at version 14, before #1671 took its routes out. */
const CANVAS_BUILD_REQUEST_V14 = (BUILD_REQUEST_V14_RAW as string).replace(/[\r\n]+$/, '')
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import BUILD_RESPONSE_BODY_BEFORE_2089_RAW from './fixtures/build_response_body.canvas-before-2089.txt?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import LEAD_ECONOMY_RETURN_RESPONSE_BEFORE_2089_RAW from './fixtures/lead_economy_return_response.canvas-before-2089.txt?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import LEAD_ECONOMY_RETURN_RESPONSE_RAW from '../../engine/scripts/lead-economy/return_response.js?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import BUILD_RESPONSE_BODY_BEFORE_2092_RAW from './fixtures/build_response_body.canvas-before-2092.txt?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import LEAD_ECONOMY_RETURN_RESPONSE_BEFORE_2092_RAW from './fixtures/lead_economy_return_response.canvas-before-2092.txt?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import RML_LENDSWIFT_BEFORE_2092_RAW from './fixtures/rml_lendswift_build_response.canvas-before-2092.txt?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import RML_GIGFI_BEFORE_2092_RAW from './fixtures/rml_gigfi_build_response.canvas-before-2092.txt?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import BIDDING_LENDSWIFT_BEFORE_2092_RAW from './fixtures/bidding_lendswift_build_response.canvas-before-2092.txt?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import RML_LENDSWIFT_RAW from '../../engine/scripts/rml-lendswift/build_response.js?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import RML_GIGFI_RAW from '../../engine/scripts/rml-gigfi/build_response.js?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import BIDDING_LENDSWIFT_RAW from '../../engine/scripts/bidding-lendswift/build_response.js?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import SIGN_SUBMISSION_LINK_RAW from '../../engine/scripts/forms-engine/sign_submission_link.js?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import TRIPOINT_PING_BEFORE_LOAN_FLOOR_RAW from './fixtures/tripoint_ping.canvas-before-loan-floor.txt?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import BUILD_RESPONSE_BODY_BEFORE_UNSOLD_SELL_OFF_RAW from './fixtures/build_response_body.canvas-before-unsold-sell-off.txt?raw'
/**
 * The canvas build_response_body before a sell off lead no buyer took was rejected, exactly as
 * version 112 held it on 2026-10-19 (its hash is the baseline). It carries the #2089 and #2092
 * edits, so the tests about those read it rather than the kept file.
 */
const BEFORE_UNSOLD_SELL_OFF_BUILD_RESPONSE_BODY = BUILD_RESPONSE_BODY_BEFORE_UNSOLD_SELL_OFF_RAW as string
/** The canvas scripts the #2089 edits were derived from, read from the mirror on 2026-10-14. */
const BEFORE_2089_BUILD_RESPONSE_BODY = (BUILD_RESPONSE_BODY_BEFORE_2089_RAW as string).replace(/[\r\n]+$/, '')
const BEFORE_2089_LEAD_ECONOMY_RETURN_RESPONSE = (LEAD_ECONOMY_RETURN_RESPONSE_BEFORE_2089_RAW as string).replace(/[\r\n]+$/, '')
/**
 * The canvas scripts the #2092 edits were derived from, exactly as the mirror held
 * them on 2026-10-15 (no newline trimmed: their hashes are the baselines).
 */
const BEFORE_2092 = {
  build_response_body: BUILD_RESPONSE_BODY_BEFORE_2092_RAW as string,
  lead_economy_return_response: LEAD_ECONOMY_RETURN_RESPONSE_BEFORE_2092_RAW as string,
  rml_lendswift: RML_LENDSWIFT_BEFORE_2092_RAW as string,
  rml_gigfi: RML_GIGFI_BEFORE_2092_RAW as string,
  bidding_lendswift: BIDDING_LENDSWIFT_BEFORE_2092_RAW as string,
}

/**
 * A script with its link signing taken out: the host list and the helper block
 * (from the host list's comment, or the BEGIN marker where there is no list, to the
 * END marker line). What is left is everything a #2092 paste must not change.
 */
function withoutSigningBlock(script: string): string {
  const begin = script.indexOf('// BEGIN link token (#2089)')
  const hosts = script.indexOf('// The hosts that get the link token')
  const start = hosts >= 0 && hosts < begin ? hosts : begin
  const endMarker = '// END link token (#2089)\n'
  const end = script.indexOf(endMarker)
  if (begin < 0 || end < 0) throw new Error('no link token block')
  return script.slice(0, start) + script.slice(end + endMarker.length)
}
const LIBERTY1_ON_DISK: Record<string, string> = {
  'resolve_click_input.js': RESOLVE_CLICK_INPUT_RAW as string,
  'pick_click_record.js': PICK_CLICK_RECORD_RAW as string,
  'build_liberty1_request.js': BUILD_LIBERTY1_REQUEST_RAW as string,
  'liberty1_click_patch.js': LIBERTY1_CLICK_PATCH_RAW as string,
}
const ON_DISK: Record<string, string> = {
  'tripoint_ping.js': TRIPOINT_PING_RAW as string,
  'build_response_body.js': BUILD_RESPONSE_BODY_RAW as string,
  'patch_prospect_body.js': PATCH_PROSPECT_BODY_RAW as string,
  'known_no_gate.js': KNOWN_NO_GATE_RAW as string,
}

const codeNode = (namespace: string, script: string, type = 'code') => ({ id: `id-${namespace}`, namespace, type, config: { script } })
const definitionWith = (...nodes: unknown[]) => ({ nodes })

async function keptFor(script: string, baselineOf: string): Promise<KeptScript> {
  return { namespace: 'tripoint_ping', file: 'tripoint_ping.js', script, canvasBaselineSha256: await sha256Hex(baselineOf), baselineReadOn: '2026-09-22' }
}

describe('the kept scripts the check compares', () => {
  it('are the three Engine sale scripts and the known no gate (#1544), each the file on disk byte for byte', () => {
    // The runtime reads the scripts through a text module, and this is the one
    // place that proves the module holds the file's own bytes rather than a
    // transformed or stale copy (L3).
    expect(KEPT_ENGINE_SCRIPTS.map((k) => k.namespace).sort()).toEqual(['build_response_body', 'known_no_gate', 'patch_prospect_body', 'tripoint_ping'])
    for (const kept of KEPT_ENGINE_SCRIPTS) {
      expect(kept.script, kept.file).toBe(ON_DISK[kept.file])
      expect(kept.script.length).toBeGreaterThan(500)
    }
  })

  it('carry no whitespace the canvas serialiser would strip on save, so a paste cannot differ from its file by hygiene alone', () => {
    for (const kept of KEPT_ENGINE_SCRIPTS) expect(stripTrailingWhitespace(kept.script), kept.file).toBe(kept.script)
  })

  it('carry no canvas baseline and no new node allowance, tripoint_ping and build_response_body apart: the canvas holds the other two, so any difference is a drift or a missing node', () => {
    for (const kept of KEPT_ENGINE_SCRIPTS.filter((k) => k.namespace !== 'tripoint_ping' && k.namespace !== 'build_response_body')) {
      expect(kept.newNodeSince, kept.file).toBeUndefined()
      expect(kept.canvasBaselineSha256, kept.file).toBeNull()
      expect(kept.baselineReadOn, kept.file).toBeNull()
    }
  })

  it('tripoint_ping awaits its loan minimum paste: the canvas script it was derived from reads as awaiting, not drift', async () => {
    // The canvas script as the live definition held it on 2026-10-15, exactly (its hash is the baseline).
    const before = TRIPOINT_PING_BEFORE_LOAN_FLOOR_RAW as string
    const kept = KEPT_ENGINE_SCRIPTS.find((k) => k.namespace === 'tripoint_ping')!
    expect(kept.newNodeSince).toBeUndefined()
    expect(kept.canvasBaselineSha256).toBe(await sha256Hex(before))
    expect(kept.baselineReadOn).toBe('2026-10-15')
    const definition = (script: string) => ({ nodes: [{ type: 'code', namespace: 'tripoint_ping', config: { script } }] })
    expect((await judgeKeptScripts([kept], definition(before), 'Engine Bidding Workflow'))[0].state).toBe('awaiting_paste')
    expect((await judgeKeptScripts([kept], definition(kept.script), 'Engine Bidding Workflow'))[0].state).toBe('agree')
  })

  it('build_response_body awaits its unsold sell off paste: the canvas script it was derived from reads as awaiting, not drift', async () => {
    const kept = KEPT_ENGINE_SCRIPTS.find((k) => k.namespace === 'build_response_body')!
    expect(kept.newNodeSince).toBeUndefined()
    expect(kept.canvasBaselineSha256).toBe(await sha256Hex(BEFORE_UNSOLD_SELL_OFF_BUILD_RESPONSE_BODY))
    expect(kept.baselineReadOn).toBe('2026-10-19')
    const definition = (script: string) => ({ nodes: [{ type: 'code', namespace: 'build_response_body', config: { script } }] })
    expect((await judgeKeptScripts([kept], definition(BEFORE_UNSOLD_SELL_OFF_BUILD_RESPONSE_BODY), 'Engine Bidding Workflow'))[0].state).toBe('awaiting_paste')
    expect((await judgeKeptScripts([kept], definition(BEFORE_UNSOLD_SELL_OFF_BUILD_RESPONSE_BODY + '\n// edited'), 'Engine Bidding Workflow'))[0].state).toBe('drift')
    expect((await judgeKeptScripts([kept], definition(kept.script), 'Engine Bidding Workflow'))[0].state).toBe('agree')
  })

  it('build_response_body differs from the canvas script it was derived from only by the unsold sell off rejection', () => {
    const kept = KEPT_ENGINE_SCRIPTS.find((k) => k.namespace === 'build_response_body')!.script
    const rule = /\/\/ A sell off lead that no buyer took is rejected the same way[\s\S]*?const unsoldSellOff = [^\n]*\n/
    expect(kept).toMatch(rule)
    const undone = kept
      .replace(rule, '')
      .replace('  if (declined || unsoldSellOff) {', '  if (declined) {')
      .replace('// is rejected above, so the Pennie pages below are for a lead that is not a sell off.', '// now takes the Pennie pages below, which is where a lead with no sale belongs.')
    expect(undone).toBe(BEFORE_UNSOLD_SELL_OFF_BUILD_RESPONSE_BODY)
  })

  it('build_response_body pages a canvas put back to its #2089 script as a drift, now that the #2092 save landed (2026-10-15 10:16 AM ET)', async () => {
    const kept = KEPT_ENGINE_SCRIPTS.find((k) => k.namespace === 'build_response_body')!
    const definition = (script: string) => ({ nodes: [{ type: 'code', namespace: 'build_response_body', config: { script } }] })
    expect((await judgeKeptScripts([kept], definition(BEFORE_2092.build_response_body), 'Engine Bidding Workflow'))[0].state).toBe('drift')
    expect((await judgeKeptScripts([kept], definition(kept.script), 'Engine Bidding Workflow'))[0].state).toBe('agree')
  })

  it('build_response_body still pages a canvas put back to its pre #2089 script as a drift (#2093)', async () => {
    // A restore of the old script would send every offer link out unsigned, and
    // trypennie.com refuses those for records created after its cutoff.
    const kept = KEPT_ENGINE_SCRIPTS.find((k) => k.namespace === 'build_response_body')!
    const before = BEFORE_2089_BUILD_RESPONSE_BODY
    const definition = (script: string) => ({ nodes: [{ type: 'code', namespace: 'build_response_body', config: { script } }] })
    const [restored] = await judgeKeptScripts([kept], definition(before), 'Engine Bidding Workflow')
    expect(restored.state).toBe('drift')
    const [drift] = await judgeKeptScripts([kept], definition(before + '\n// edited'), 'Engine Bidding Workflow')
    expect(drift.state).toBe('drift')
  })

  it('build_response_body differs from its #2092 baseline only inside the link token block and its host list, so the paste changes no offer', () => {
    const kept = BEFORE_UNSOLD_SELL_OFF_BUILD_RESPONSE_BODY
    expect(withoutSigningBlock(kept).replace(/[\r\n]+$/, '')).toBe(withoutSigningBlock(BEFORE_2092.build_response_body).replace(/[\r\n]+$/, ''))
  })

  it('build_response_body differs from the canvas script before #2089 only by the link token', () => {
    const kept = withoutSigningBlock(BEFORE_UNSOLD_SELL_OFF_BUILD_RESPONSE_BODY)
    const wiring = "\nconst prospectId = steps.create_prospect.output.body.id;\n// A click sale's landing page already carries the prospect id (#1544).\nconst offerLink = await withLinkToken(clickSale ? redirectUrl : redirectUrl + `/${prospectId}`, prospectId);\n\n"
    const undone = kept
      .replace(wiring, '')
      .replace('        click_url:    offerLink.url,', "        // A click sale's landing page already carries the prospect id (#1544).\n        click_url:    clickSale ? redirectUrl : redirectUrl + `/${steps.create_prospect.output.body.id}`,")
      .replace('  link_token: offerLink.link_token,\n', '')
      .replace(/[\r\n]+$/, '')
    expect(undone).toBe(BEFORE_2089_BUILD_RESPONSE_BODY)
  })

  it('pages a canvas edit to known_no_gate as drift, now that it carries no baseline', async () => {
    const gate = KEPT_ENGINE_SCRIPTS.find((k) => k.namespace === 'known_no_gate')!
    const edited = `${gate.script.replace(/[\r\n]+$/, '')}\n// an edit made on the canvas only`
    const [verdict] = await judgeKeptScripts([gate], { nodes: [{ type: 'code', namespace: 'known_no_gate', config: { script: edited } }] }, 'Engine Bidding')
    expect(verdict.state).toBe('drift')
  })

  it('names the Engine Bidding Workflow the parity and contract code already name', () => {
    expect(ENGINE_BIDDING_WORKFLOW_ID).toBe('da82a183-1a4a-417e-b0b8-5f3fe5e14840')
    expect(ENGINE_SCRIPT_DRIFT_JOB).toBe('engine-script-drift')
  })
})

describe('judgeKeptScripts', () => {
  const KEPT = 'line one\nline two\nline three\n'
  const BASELINE = 'line one\nold line two\nline three'

  it('agree when the canvas holds the kept script', async () => {
    const kept = await keptFor(KEPT, BASELINE)
    const [v] = await judgeKeptScripts([kept], definitionWith(codeNode('tripoint_ping', KEPT)), 'W')
    expect(v).toEqual({ workflow: 'W', namespace: 'tripoint_ping', file: 'tripoint_ping.js', state: 'agree' })
  })

  it('agree when only the final newline differs, because a file in git ends with one and a script box need not', async () => {
    const kept = await keptFor(KEPT, BASELINE)
    const [v] = await judgeKeptScripts([kept], definitionWith(codeNode('tripoint_ping', KEPT.replace(/\n$/, ''))), 'W')
    expect(v.state).toBe('agree')
  })

  it('awaiting_paste when the canvas still holds exactly the script the kept copy was derived from', async () => {
    const kept = await keptFor(KEPT, BASELINE)
    const [v] = await judgeKeptScripts([kept], definitionWith(codeNode('tripoint_ping', BASELINE)), 'W')
    expect(v).toEqual({ workflow: 'W', namespace: 'tripoint_ping', file: 'tripoint_ping.js', state: 'awaiting_paste', baselineReadOn: '2026-09-22' })
  })

  it('drift when the canvas matches neither, naming the first differing line and both versions of it', async () => {
    const kept = await keptFor(KEPT, BASELINE)
    const [v] = await judgeKeptScripts([kept], definitionWith(codeNode('tripoint_ping', 'line one\nline two\nsomebody edited this\n')), 'W')
    expect(v).toEqual({
      workflow: 'W',
      namespace: 'tripoint_ping',
      file: 'tripoint_ping.js',
      state: 'drift',
      line: 3,
      kept: 'line three',
      canvas: 'somebody edited this',
    })
  })

  it('drift when the canvas is a prefix of the kept script, naming the line the canvas lacks', async () => {
    const kept = await keptFor(KEPT, BASELINE)
    const [v] = await judgeKeptScripts([kept], definitionWith(codeNode('tripoint_ping', 'line one\nline two\n')), 'W')
    expect(v).toMatchObject({ state: 'drift', line: 3, kept: 'line three', canvas: null })
  })

  it('missing_node when no code node on the canvas carries the namespace, and a non code node of that name does not count', async () => {
    const kept = await keptFor(KEPT, BASELINE)
    const [v] = await judgeKeptScripts([kept], definitionWith(codeNode('tripoint_ping', KEPT, 'buyer_select'), codeNode('other', KEPT)), 'W')
    expect(v).toEqual({ workflow: 'W', namespace: 'tripoint_ping', file: 'tripoint_ping.js', state: 'missing_node' })
  })

  it('a new node not yet on the canvas is a first paste awaited, never a missing node, and says so in its own words (#1544)', async () => {
    const kept: KeptScript = { namespace: 'gate', file: 'gate.js', script: KEPT, canvasBaselineSha256: null, baselineReadOn: null, newNodeSince: '2026-09-24' }
    const [v] = await judgeKeptScripts([kept], definitionWith(codeNode('other', KEPT)), 'W')
    expect(v).toEqual({ workflow: 'W', namespace: 'gate', file: 'gate.js', state: 'awaiting_paste', baselineReadOn: '2026-09-24', newNode: true })
    expect(describeVerdict(v)).toBe('W, gate: the canvas has no such node yet; gate.js was written for it on 2026-09-24 and awaits its first paste.')
  })

  it('once the new node is on the canvas it is judged like any other: its own script agrees, anything else is a drift', async () => {
    const kept: KeptScript = { namespace: 'gate', file: 'gate.js', script: KEPT, canvasBaselineSha256: null, baselineReadOn: null, newNodeSince: '2026-09-24' }
    expect((await judgeKeptScripts([kept], definitionWith(codeNode('gate', KEPT)), 'W'))[0].state).toBe('agree')
    expect((await judgeKeptScripts([kept], definitionWith(codeNode('gate', 'return 1')), 'W'))[0].state).toBe('drift')
  })

  it('judges every kept script, in order', async () => {
    const a = { ...(await keptFor(KEPT, BASELINE)), namespace: 'a', file: 'a.js' }
    const b = { ...(await keptFor(KEPT, BASELINE)), namespace: 'b', file: 'b.js' }
    const verdicts = await judgeKeptScripts([a, b], definitionWith(codeNode('a', KEPT), codeNode('b', BASELINE)), 'W')
    expect(verdicts.map((v) => [v.namespace, v.state])).toEqual([['a', 'agree'], ['b', 'awaiting_paste']])
  })
})

describe('describeVerdict', () => {
  it('names the node, the file and the line for a drift, and quotes both lines', () => {
    const line = describeVerdict({ workflow: 'Engine Bidding Workflow', namespace: 'tripoint_ping', file: 'tripoint_ping.js', state: 'drift', line: 4, kept: 'const a = 1', canvas: 'const a = 2' })
    expect(line).toContain('Engine Bidding Workflow')
    expect(line).toContain('tripoint_ping')
    expect(line).toContain('tripoint_ping.js')
    expect(line).toContain('line 4')
    expect(line).toContain('const a = 1')
    expect(line).toContain('const a = 2')
  })

  it('says the canvas has no such node for a missing node', () => {
    const line = describeVerdict({ workflow: 'Engine Bidding Workflow', namespace: 'patch_prospect_body', file: 'patch_prospect_body.js', state: 'missing_node' })
    expect(line).toContain('patch_prospect_body')
    expect(line.toLowerCase()).toContain('no code node')
  })

  it('truncates a long differing line rather than posting a script to Slack', () => {
    const long = 'x'.repeat(500)
    const line = describeVerdict({ workflow: 'W', namespace: 'n', file: 'n.js', state: 'drift', line: 1, kept: long, canvas: long })
    expect(line.length).toBeLessThan(500)
  })
})

describe('readMirrorDefinition', () => {
  const repo = 'Try-Pennie/bidspoke-workflows'
  const okBody = JSON.stringify({ id: ENGINE_BIDDING_WORKFLOW_ID, name: 'Engine', definition: { nodes: [] } })

  it('asks the backup repo for the raw mirror file with the token and the User-Agent GitHub requires', async () => {
    const fetchImpl = vi.fn(async () => new Response(okBody, { status: 200 }))
    const read = await readMirrorDefinition({ repo, token: 'tok', workflowId: ENGINE_BIDDING_WORKFLOW_ID, fetch: fetchImpl as unknown as typeof fetch })
    expect(read).toEqual({ ok: true, definition: { nodes: [] } })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://api.github.com/repos/${repo}/contents/workflows/${ENGINE_BIDDING_WORKFLOW_ID}.json`)
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok')
    expect(headers.Accept).toBe('application/vnd.github.raw+json')
    expect(headers['User-Agent']).toBeTruthy()
  })

  it('reports a non 2xx answer by status and body rather than as an empty canvas (L215)', async () => {
    const fetchImpl = vi.fn(async () => new Response('Not Found', { status: 404 }))
    const read = await readMirrorDefinition({ repo, token: 'tok', workflowId: ENGINE_BIDDING_WORKFLOW_ID, fetch: fetchImpl as unknown as typeof fetch })
    expect(read.ok).toBe(false)
    if (!read.ok) {
      expect(read.reason).toContain('404')
      expect(read.reason).toContain('Not Found')
    }
  })

  it('reports a body that is not the mirror shape', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"id":"x"}', { status: 200 }))
    const read = await readMirrorDefinition({ repo, token: 'tok', workflowId: ENGINE_BIDDING_WORKFLOW_ID, fetch: fetchImpl as unknown as typeof fetch })
    expect(read).toMatchObject({ ok: false })
    if (!read.ok) expect(read.reason.toLowerCase()).toContain('definition')
  })

  it('reports a thrown fetch by its message', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('socket hang up') })
    const read = await readMirrorDefinition({ repo, token: 'tok', workflowId: ENGINE_BIDDING_WORKFLOW_ID, fetch: fetchImpl as unknown as typeof fetch })
    expect(read).toMatchObject({ ok: false, reason: expect.stringContaining('socket hang up') })
  })
})

describe('runEngineScriptDrift', () => {
  const KEPT = 'kept\n'
  const BASELINE = 'baseline'
  const mirror = (script: string) => JSON.stringify({ id: ENGINE_BIDDING_WORKFLOW_ID, name: 'Engine', definition: { nodes: [codeNode('tripoint_ping', script)] } })

  async function deps(over: Partial<DriftDeps> = {}, canvas = KEPT): Promise<DriftDeps> {
    return {
      repo: 'Try-Pennie/bidspoke-workflows',
      token: 'tok',
      workflows: [{ name: 'Engine Bidding Workflow', workflowId: ENGINE_BIDDING_WORKFLOW_ID, folder: 'engine-bidding', scripts: [await keptFor(KEPT, BASELINE)], configSources: [] }],
      fetch: (async () => new Response(mirror(canvas), { status: 200 })) as unknown as typeof fetch,
      localDev: false,
      log: () => {},
      ...over,
    }
  }

  it('is skipped with no repo configured, because then there is no mirror to compare against (the backup is off)', async () => {
    const s = await runEngineScriptDrift(await deps({ repo: undefined }))
    expect(s).toEqual({ skipped: 'no_repo', verdicts: [], configVerdicts: [], findings: [] })
  })

  it('is skipped in local dev, which has no backup token and would page production Slack', async () => {
    const s = await runEngineScriptDrift(await deps({ localDev: true }))
    expect(s.skipped).toBe('local_dev')
    expect(s.findings).toEqual([])
  })

  it('a repo with no token is a misconfiguration and a finding, as it is for the backup itself', async () => {
    const fetchImpl = vi.fn()
    const s = await runEngineScriptDrift(await deps({ token: undefined, fetch: fetchImpl as unknown as typeof fetch }))
    expect(s.findings).toHaveLength(1)
    expect(s.findings[0]).toContain('GITHUB_TOKEN')
    expect(s.unreadable).toBeTruthy()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('an unreadable mirror is its own finding, distinct from a drift, and judges nothing (L11)', async () => {
    const s = await runEngineScriptDrift(await deps({ fetch: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch }))
    expect(s.verdicts).toEqual([])
    expect(s.unreadable).toContain('500')
    expect(s.findings).toHaveLength(1)
    expect(s.findings[0].toLowerCase()).toContain('could not read')
    expect(s.findings[0]).not.toContain('drift')
  })

  it('agreement and an awaited paste produce no findings', async () => {
    expect((await runEngineScriptDrift(await deps({}, KEPT))).findings).toEqual([])
    const awaiting = await runEngineScriptDrift(await deps({}, BASELINE))
    expect(awaiting.findings).toEqual([])
    expect(awaiting.verdicts.map((v) => v.state)).toEqual(['awaiting_paste'])
  })

  it('a drift is a finding naming the node', async () => {
    const s = await runEngineScriptDrift(await deps({}, 'edited on the canvas'))
    expect(s.verdicts.map((v) => v.state)).toEqual(['drift'])
    expect(s.findings).toHaveLength(1)
    expect(s.findings[0]).toContain('tripoint_ping')
  })
})

describe('runEngineScriptDriftAndPage', () => {
  const summary = (over: Partial<DriftSummary>): DriftSummary => ({ verdicts: [], configVerdicts: [], findings: [], ...over })
  const run = (s: DriftSummary) => async () => s

  it('pages the findings and clears a standing page with an empty list on a clean run', async () => {
    const notify = vi.fn(async () => {})
    await runEngineScriptDriftAndPage(run(summary({ findings: ['x drifted'] })), notify)
    expect(notify).toHaveBeenCalledWith(['x drifted'], expect.objectContaining({ fixHint: expect.any(String) }))
    await runEngineScriptDriftAndPage(run(summary({})), notify)
    expect(notify).toHaveBeenLastCalledWith([], expect.anything())
  })

  it('does not speak for the job when the run was skipped, so a skip neither pages nor clears (L11)', async () => {
    const notify = vi.fn(async () => {})
    await runEngineScriptDriftAndPage(run(summary({ skipped: 'local_dev' })), notify)
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('endingOf', () => {
  const agree = { workflow: 'W', namespace: 'a', file: 'a.js', state: 'agree' as const }
  const awaiting = { workflow: 'W', namespace: 'b', file: 'b.js', state: 'awaiting_paste' as const, baselineReadOn: '2026-09-22' }
  const drift = { workflow: 'W', namespace: 'c', file: 'c.js', state: 'drift' as const, line: 1, kept: 'k', canvas: 'v' }
  const notBuilt = { workflow: 'L', namespace: 'd', file: 'd.js', state: 'not_built' as const }

  it('records skipped, unmeasured, findings, awaiting_paste and ok as distinct outcomes', () => {
    expect(endingOf({ skipped: 'no_repo', verdicts: [], configVerdicts: [], findings: [] }).outcome).toBe('skipped')
    expect(endingOf({ verdicts: [], configVerdicts: [], findings: ['could not read'], unreadable: '500' }).outcome).toBe('unmeasured')
    expect(endingOf({ verdicts: [agree, drift], configVerdicts: [], findings: ['c drifted'] }).outcome).toBe('findings')
    expect(endingOf({ verdicts: [agree, awaiting], configVerdicts: [], findings: [] })).toMatchObject({ outcome: 'awaiting_paste', summary: { awaiting: ['W/b'] } })
    expect(endingOf({ verdicts: [agree, agree], configVerdicts: [], findings: [] }).outcome).toBe('ok')
  })

  it('a workflow not built yet is listed as not_built and does not stop the run reading ok', () => {
    expect(endingOf({ verdicts: [agree, notBuilt], configVerdicts: [], findings: [] })).toMatchObject({ outcome: 'ok', summary: { not_built: ['L/d'] } })
  })

  it('one unreadable mirror beside a judged workflow still records what was judged, as findings', () => {
    expect(endingOf({ verdicts: [agree], configVerdicts: [], findings: ['could not read'], unreadable: 'L: 500' }).outcome).toBe('findings')
    expect(endingOf({ verdicts: [notBuilt], configVerdicts: [], findings: ['could not read'], unreadable: 'W: 500' }).outcome).toBe('unmeasured')
  })

  it('lists every script and its state in the summary, so job_runs shows which paste landed', () => {
    const ending = endingOf({ verdicts: [agree, awaiting], configVerdicts: [], findings: [] })
    expect(ending.summary).toMatchObject({ scripts: { 'W/a': 'agree', 'W/b': 'awaiting_paste' } })
  })
})

describe('Lead Economy (#2089)', () => {
  const leadEconomy = KEPT_CANVAS_WORKFLOWS.find((w) => w.folder === 'lead-economy')

  it('is watched on its live workflow with return_response, the file on disk, with no baseline now its #2092 save has landed', async () => {
    expect(leadEconomy?.workflowId).toBe('89b1a6af-7e0f-43de-bc66-1e888184551f')
    expect(leadEconomy?.configSources).toEqual([])
    expect(leadEconomy?.scripts.map((k) => k.namespace)).toEqual(['return_response'])
    const kept = leadEconomy!.scripts[0]
    expect(kept.script).toBe(LEAD_ECONOMY_RETURN_RESPONSE_RAW as string)
    expect(stripTrailingWhitespace(kept.script)).toBe(kept.script)
    expect(kept.newNodeSince).toBeUndefined()
    expect(kept.canvasBaselineSha256).toBeNull()
    expect(kept.baselineReadOn).toBeNull()
    const definition = (script: string) => ({ nodes: [{ type: 'code', namespace: 'return_response', config: { script } }] })
    expect((await judgeKeptScripts([kept], definition(BEFORE_2092.lead_economy_return_response), 'Lead Economy'))[0].state).toBe('drift')
    // Put back to the script before #2089, every offer link goes out unsigned, so it pages.
    expect((await judgeKeptScripts([kept], definition(BEFORE_2089_LEAD_ECONOMY_RETURN_RESPONSE), 'Lead Economy'))[0].state).toBe('drift')
    expect((await judgeKeptScripts([kept], definition(kept.script), 'Lead Economy'))[0].state).toBe('agree')
    expect((await judgeKeptScripts([kept], definition(BEFORE_2089_LEAD_ECONOMY_RETURN_RESPONSE + '\n// edited'), 'Lead Economy'))[0].state).toBe('drift')
  })

  it('differs from its #2092 baseline only inside the link token block and its host list', () => {
    const kept = leadEconomy!.scripts[0].script
    expect(withoutSigningBlock(kept).replace(/[\r\n]+$/, '')).toBe(withoutSigningBlock(BEFORE_2092.lead_economy_return_response).replace(/[\r\n]+$/, ''))
  })

  it('differs from the canvas script before #2089 only by the link token', () => {
    // Everything else in the kept file is the live script byte for byte, so the paste
    // changes nothing but the offer link.
    const kept = withoutSigningBlock(leadEconomy!.scripts[0].script)
    const undone = kept
      .replace('\nconst prospectId = steps.create_prospect.output.body.id;\nconst offerLink = await withLinkToken(`${redirectUrl}/${prospectId}`, prospectId);\n\n', '')
      .replace('    click_url: offerLink.url,', '    click_url: `${redirectUrl}/${steps.create_prospect.output.body.id}`,')
      .replace(', respondedAt, link_token: offerLink.link_token };', ', respondedAt };')
      .replace(/[\r\n]+$/, '')
    expect(undone).toBe(BEFORE_2089_LEAD_ECONOMY_RETURN_RESPONSE)
  })
})

describe('the RML bidding flows (#2092)', () => {
  const RML = [
    { folder: 'rml-lendswift', name: 'RML - Bidding Workflow (LendSwift)', id: 'e1b810da-16c0-49eb-bf12-ba1c9b67c914', onDisk: RML_LENDSWIFT_RAW as string, before: BEFORE_2092.rml_lendswift },
    { folder: 'rml-gigfi', name: 'RML - Bidding Workflow (GigFi)', id: '6624acd0-bf61-4d21-85fc-4371ca7ed77d', onDisk: RML_GIGFI_RAW as string, before: BEFORE_2092.rml_gigfi },
    { folder: 'bidding-lendswift', name: 'Bidding - LendSwift', id: '0f4df7a7-2405-4fc7-9af4-5d5e05ce96c5', onDisk: BIDDING_LENDSWIFT_RAW as string, before: BEFORE_2092.bidding_lendswift },
  ]

  for (const flow of RML) {
    const watched = KEPT_CANVAS_WORKFLOWS.find((w) => w.folder === flow.folder)

    it(`${flow.name} is watched on its live workflow with build_response, the file on disk, with no baseline now its save has landed`, async () => {
      expect(watched?.name).toBe(flow.name)
      expect(watched?.workflowId).toBe(flow.id)
      expect(watched?.configSources).toEqual([])
      expect(watched?.scripts.map((k) => k.namespace)).toEqual(['build_response'])
      const kept = watched!.scripts[0]
      expect(kept.script).toBe(flow.onDisk)
      expect(stripTrailingWhitespace(kept.script)).toBe(kept.script)
      expect(kept.newNodeSince).toBeUndefined()
      expect(kept.canvasBaselineSha256).toBeNull()
      expect(kept.baselineReadOn).toBeNull()
      const definition = (script: string) => ({ nodes: [{ type: 'code', namespace: 'build_response', config: { script } }] })
      // Put back to the unsigned script, every reservemyloan link goes out without its token, so it pages.
      expect((await judgeKeptScripts([kept], definition(flow.before), flow.name))[0].state).toBe('drift')
      expect((await judgeKeptScripts([kept], definition(kept.script), flow.name))[0].state).toBe('agree')
      expect((await judgeKeptScripts([kept], definition(flow.before + '\n// edited'), flow.name))[0].state).toBe('drift')
    })

    it(`${flow.name}: the kept script is the canvas script with only the link signing added`, () => {
      // The bid, the rejections and the Salesforce patch values are the live script
      // byte for byte; only the offer's click_url and the link_token output change.
      const kept = withoutSigningBlock(watched!.scripts[0].script)
      const undone = kept
        // The signing sits between the bid and the return, set off by blank lines.
        .replace('\n\n\nconst applicantId = steps.create_applicant.output.body.id;\nconst offerLink = await withLinkToken(constants.pennieClickUrl + `/${applicantId}`, applicantId);\n', '\n')
        .replace('        click_url: offerLink.url,', '        click_url: constants.pennieClickUrl + `/${steps.create_applicant.output.body.id}`,')
        .replace('  bidAmount,\n  link_token: offerLink.link_token,\n};', '  bidAmount,\n};')
        .replace(/[\r\n]+$/, '')
      expect(undone).toBe(flow.before.replace(/[\r\n]+$/, ''))
    })
  }
})

describe('the Forms flow (#2092)', () => {
  const forms = KEPT_CANVAS_WORKFLOWS.find((w) => w.folder === 'forms-engine')

  it('is watched on its live workflow with the sign_submission_link node, which pages as missing now its first save has landed', async () => {
    expect(forms?.name).toBe('Forms <> Engine <> Data Store (Loan only)')
    expect(forms?.workflowId).toBe('ff1a9f52-7346-452a-bab7-af9f95d36dda')
    expect(forms?.scripts.map((k) => k.namespace)).toEqual(['sign_submission_link'])
    const kept = forms!.scripts[0]
    expect(kept.script).toBe(SIGN_SUBMISSION_LINK_RAW as string)
    expect(stripTrailingWhitespace(kept.script)).toBe(kept.script)
    expect(kept.newNodeSince).toBeUndefined()
    expect(kept.canvasBaselineSha256).toBeNull()
    // Saved 2026-10-15 10:16:59 AM ET: a canvas without the node would send the agent an unsigned link.
    expect((await judgeKeptScripts([kept], { nodes: [] }, 'Forms'))[0].state).toBe('missing_node')
    expect((await judgeKeptScripts([kept], { nodes: [{ type: 'code', namespace: 'sign_submission_link', config: { script: kept.script } }] }, 'Forms'))[0].state).toBe('agree')
  })
})

describe('the Liberty1 click workflow (#1545)', () => {
  const liberty1 = KEPT_CANVAS_WORKFLOWS.find((w) => w.folder === 'liberty1-click')

  it('is watched with its four kept scripts, each the file on disk, with no canvas baseline: the canvas holds all four since version 15 (2026-09-30)', () => {
    expect(liberty1?.scripts.map((k) => k.namespace)).toEqual(['resolve_input', 'pick_record', 'build_request', 'click_patch'])
    for (const kept of liberty1?.scripts ?? []) {
      expect(kept.script, kept.file).toBe(LIBERTY1_ON_DISK[kept.file])
      expect(stripTrailingWhitespace(kept.script), kept.file).toBe(kept.script)
      expect(kept.newNodeSince, kept.file).toBeUndefined()
      expect(kept.canvasBaselineSha256, kept.file).toBeNull()
      expect(kept.baselineReadOn, kept.file).toBeNull()
    }
  })

  // #1671's build_request was pasted at version 15 (2026-09-30 19:54 UTC), so the
  // routed version 14 script it replaced is no longer an awaited paste: back on the
  // canvas it is a drift, and pages.
  it('the version 14 build_request back on the canvas is a drift now the paste landed, never an awaited paste', async () => {
    const build = liberty1!.scripts.find((k) => k.namespace === 'build_request')!
    const [v] = await judgeKeptScripts([build], { nodes: [{ type: 'code', namespace: 'build_request', config: { script: CANVAS_BUILD_REQUEST_V14 } }] }, 'Liberty1 click workflow')
    expect(v.state).toBe('drift')
  })

  it('the live canvas at version 15 (the pasted build_request, click_send with no address or success line) pages nothing', async () => {
    const nodes = (liberty1File.definition.nodes as Array<{ namespace: string; type: string; config: Record<string, unknown> }>).map((n) => {
      const kept = liberty1?.scripts.find((k) => k.namespace === n.namespace)
      return kept ? { ...n, config: { ...n.config, script: kept.script.replace(/[\r\n]+$/, '') } } : n
    })
    // click_send exactly as version 15 holds it, read from workflows on 2026-09-30.
    const send = nodes.find((n) => n.type === 'buyer_click_send')!
    expect(Object.keys(send.config).sort()).toEqual(['alert_over_percent', 'partner_id', 'prospect_id', 'request_body', 'retries', 'state'])
    const fetchImpl = async () => new Response(JSON.stringify({ id: LIBERTY1_CLICK_WORKFLOW_ID, definition: { nodes } }), { status: 200 })
    const s = await runEngineScriptDrift({
      repo: 'Try-Pennie/bidspoke-workflows', token: 'tok', workflows: [liberty1!], fetch: fetchImpl as unknown as typeof fetch, localDev: false, log: () => {},
    })
    expect(s.findings).toEqual([])
    expect(s.verdicts.map((v) => [v.namespace, v.state])).toEqual([['resolve_input', 'agree'], ['pick_record', 'agree'], ['build_request', 'agree'], ['click_patch', 'agree']])
    expect(new Set(s.configVerdicts.map((v) => v.state))).toEqual(new Set(['agree']))
  })

  it('the same canvas with a request_url put back on click_send pages it as a retired setting', async () => {
    const nodes = (liberty1File.definition.nodes as Array<{ namespace: string; type: string; config: Record<string, unknown> }>).map((n) => {
      if (n.type === 'buyer_click_send') return { ...n, config: { ...n.config, request_url: '{{steps.build_request.output.url}}' } }
      const kept = liberty1?.scripts.find((k) => k.namespace === n.namespace)
      return kept ? { ...n, config: { ...n.config, script: kept.script } } : n
    })
    const fetchImpl = async () => new Response(JSON.stringify({ id: LIBERTY1_CLICK_WORKFLOW_ID, definition: { nodes } }), { status: 200 })
    const s = await runEngineScriptDrift({
      repo: 'Try-Pennie/bidspoke-workflows', token: 'tok', workflows: [liberty1!], fetch: fetchImpl as unknown as typeof fetch, localDev: false, log: () => {},
    })
    expect(s.findings).toHaveLength(1)
    expect(s.findings[0]).toContain('request_url')
    expect(s.findings[0]).toContain('click_send')
  })

  it('a canvas missing pick_record pages as a missing node, never an awaited paste', async () => {
    const definition = definitionWith(...liberty1!.scripts.filter((k) => k.namespace !== 'pick_record').map((k) => codeNode(k.namespace, k.script)))
    const verdicts = await judgeKeptScripts(liberty1!.scripts, definition, 'Liberty1 click workflow')
    expect(verdicts.find((v) => v.namespace === 'pick_record')?.state).toBe('missing_node')
  })

  it('watches the built workflow (#1547): reads its own mirror file and judges the four kept scripts on the canvas as agreeing', async () => {
    expect(LIBERTY1_CLICK_WORKFLOW_ID).toBe('8a0f65aa-49a9-441c-a47e-b2a9a5fb2b08')
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      // The committed definition with the kept scripts in its code nodes, so its node settings agree too (#1662).
      const nodes = (liberty1File.definition.nodes as Array<{ namespace: string; type: string; config: Record<string, unknown> }>).map((n) => {
        const kept = liberty1?.scripts.find((k) => k.namespace === n.namespace)
        return kept ? { ...n, config: { ...n.config, script: kept.script } } : n
      })
      return new Response(JSON.stringify({ id: LIBERTY1_CLICK_WORKFLOW_ID, definition: { nodes } }), { status: 200 })
    })
    const s = await runEngineScriptDrift({
      repo: 'Try-Pennie/bidspoke-workflows', token: 'tok', workflows: [liberty1!], fetch: fetchImpl as unknown as typeof fetch, localDev: false, log: () => {},
    })
    expect(urls.map((u) => u.split('/').pop())).toEqual(['8a0f65aa-49a9-441c-a47e-b2a9a5fb2b08.json'])
    expect(s.findings).toEqual([])
    expect(s.verdicts.map((v) => v.state)).toEqual(['agree', 'agree', 'agree', 'agree'])
  })

  it('a workflow with no id is recorded as not_built without reading any mirror or paging', async () => {
    const fetchImpl = vi.fn()
    const s = await runEngineScriptDrift({
      repo: 'Try-Pennie/bidspoke-workflows', token: 'tok', workflows: [{ ...liberty1!, workflowId: null }], fetch: fetchImpl as unknown as typeof fetch, localDev: false, log: () => {},
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(s.findings).toEqual([])
    expect(s.verdicts.map((v) => v.state)).toEqual(['not_built', 'not_built', 'not_built', 'not_built'])
  })

  it('once built, a script with no baseline that differs from the canvas is a drift, never an awaited paste', async () => {
    const kept: KeptScript = { namespace: 'click_patch', file: 'liberty1_click_patch.js', script: 'kept\n', canvasBaselineSha256: null, baselineReadOn: null }
    const [v] = await judgeKeptScripts([kept], definitionWith(codeNode('click_patch', 'edited')), 'Liberty1 click workflow')
    expect(v.state).toBe('drift')
  })

  it('reads each workflow from its own mirror file, and one unreadable mirror does not stop the other being judged', async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      if (url.includes('wf-b')) return new Response('nope', { status: 500 })
      return new Response(JSON.stringify({ definition: { nodes: [codeNode('a', 'kept\n')] } }), { status: 200 })
    })
    const script = (namespace: string): KeptScript => ({ namespace, file: `${namespace}.js`, script: 'kept\n', canvasBaselineSha256: null, baselineReadOn: null })
    const s = await runEngineScriptDrift({
      repo: 'Try-Pennie/bidspoke-workflows', token: 'tok', fetch: fetchImpl as unknown as typeof fetch, localDev: false, log: () => {},
      workflows: [
        { name: 'A flow', workflowId: 'wf-a', folder: 'a', scripts: [script('a')], configSources: [] },
        { name: 'B flow', workflowId: 'wf-b', folder: 'b', scripts: [script('b')], configSources: [] },
      ],
    })
    expect(urls.map((u) => u.split('/').pop())).toEqual(['wf-a.json', 'wf-b.json'])
    expect(s.verdicts).toEqual([{ workflow: 'A flow', namespace: 'a', file: 'a.js', state: 'agree' }])
    expect(s.findings).toHaveLength(1)
    expect(s.findings[0]).toContain('B flow')
    expect(s.unreadable).toContain('500')
  })
})

/**
 * The page's How to fix line is derived from the kinds of finding the run made
 * (#1671, L111): a retired setting is fixed only by removing it from the canvas
 * node, since the node ignores it and the buyer profile's Click delivery holds
 * it, so a page holding only that finding must never tell anyone to copy the
 * canvas value into the repo or set it back on the node.
 */
describe('the remedy follows the kind of finding', () => {
  const liberty1 = KEPT_CANVAS_WORKFLOWS.find((w) => w.folder === 'liberty1-click')!
  type N = { namespace: string; type: string; config: Record<string, unknown> }
  const canvas = (edit: (n: N) => N): N[] =>
    (liberty1File.definition.nodes as N[]).map((n) => {
      const kept = liberty1.scripts.find((k) => k.namespace === n.namespace)
      return edit(kept ? { ...n, config: { ...n.config, script: kept.script } } : n)
    })
  async function page(nodes: N[]) {
    const fetchImpl = async () => new Response(JSON.stringify({ id: LIBERTY1_CLICK_WORKFLOW_ID, definition: { nodes } }), { status: 200 })
    const calls: Array<{ lines: string[]; remedy: { consequence: string; fixHint: string } }> = []
    await runEngineScriptDriftAndPage(
      () => runEngineScriptDrift({ repo: 'Try-Pennie/bidspoke-workflows', token: 'tok', workflows: [liberty1], fetch: fetchImpl as unknown as typeof fetch, localDev: false, log: () => {} }),
      async (lines, remedy) => { calls.push({ lines, remedy }) },
    )
    expect(calls).toHaveLength(1)
    return calls[0]
  }
  const withRetired = (n: N): N => (n.type === 'buyer_click_send' ? { ...n, config: { ...n.config, success_pattern: 'OK (?<id>\\d+)' } } : n)
  const withDrift = (n: N): N => (n.type === 'buyer_click_send' ? { ...n, config: { ...n.config, state: '{{trigger.payload.state}}' } } : n)

  it('a page holding only a retired setting says to remove it from the node and save, and never to commit it or set it back', async () => {
    const { lines, remedy } = await page(canvas(withRetired))
    expect(lines).toHaveLength(1)
    const text = `${lines.join(' ')} ${remedy.consequence} ${remedy.fixHint}`
    expect(lines[0]).toContain('Remove the old address and success line')
    expect(remedy.fixHint).toMatch(/remove it from the node/i)
    expect(remedy.fixHint).toContain('save')
    for (const wrong of ['in a PR', 'copy it into', 'set it back', 'canvasBaselineSha256', 'kept file']) expect(text, wrong).not.toContain(wrong)
  })

  it('a page holding only a setting drift keeps the copy or set back remedy, with nothing about retired settings', async () => {
    const { remedy } = await page(canvas(withDrift))
    expect(remedy.fixHint).toContain('copy it into the committed file')
    expect(remedy.fixHint).not.toMatch(/remove it from the node/i)
  })

  it('a page holding both carries both remedies, each once', async () => {
    const { lines, remedy } = await page(canvas((n) => withDrift(withRetired(n))))
    expect(lines).toHaveLength(2)
    expect(remedy.fixHint).toContain('copy it into the committed file')
    expect(remedy.fixHint.match(/remove it from the node/gi)).toHaveLength(1)
  })

  it('a clean run carries the full remedy with its clear, which no page shows', async () => {
    const { lines } = await page(canvas((n) => n))
    expect(lines).toEqual([])
  })
})

/**
 * A run that compared nothing, and a node that is not there, are not a canvas
 * edit to copy back (#835): the copy and paste fix used to come with both.
 */
describe('the remedy for a mirror it could not read, and a node that is gone (#835)', () => {
  const base = { workflow: 'Engine Bidding Workflow', namespace: 'tripoint_ping', file: 'f.js' }
  const COPY = /copy the canvas script into the kept file|copy it into the committed file/

  it('a run that read no mirror says so in its own words and gives only the read fix', () => {
    const r = driftRemedyFor({ verdicts: [], configVerdicts: [], findings: ['could not read the canvas mirror: 401'], unreadable: '401' })
    expect(r).toBe(ENGINE_SCRIPT_DRIFT_UNREADABLE_REMEDY)
    expect(r.consequence).not.toMatch(/holds a code node script/)
    expect(r.fixHint).not.toMatch(COPY)
    expect(r.fixHint).toMatch(/GitHub token/)
  })

  it('a missing code node gets the gone node fix, never the copy and paste one', () => {
    const r = driftRemedyFor({ verdicts: [{ ...base, state: 'missing_node' }], configVerdicts: [], findings: ['x'] })
    expect(r.fixHint).toMatch(/renamed, removed or replaced/)
    expect(r.fixHint).not.toMatch(COPY)
  })

  it('a node whose type changed, or that the committed definition names and the canvas lacks, gets the gone node fix', () => {
    const changed = driftRemedyFor({ verdicts: [], configVerdicts: [{ ...base, state: 'type_changed', committedType: 'code', canvasType: 'filter' }], findings: ['x'] })
    const gone = driftRemedyFor({ verdicts: [], configVerdicts: [{ ...base, state: 'missing_node', nodeType: 'buyer_select' }], findings: ['x'] })
    for (const r of [changed, gone]) {
      expect(r.fixHint).toMatch(/renamed, removed or replaced/)
      expect(r.fixHint).not.toMatch(COPY)
    }
  })

  it('a drift beside a mirror it could not read carries both fixes', () => {
    const r = driftRemedyFor({ verdicts: [{ ...base, state: 'drift', line: 3, kept: 'a', canvas: 'b' }], configVerdicts: [], findings: ['x', 'y'], unreadable: '401' })
    expect(r.fixHint).toMatch(/copy the canvas script into the kept file/)
    expect(r.fixHint).toMatch(/GitHub token/)
  })
})
