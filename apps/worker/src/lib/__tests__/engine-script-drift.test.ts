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

  it('carry no new node allowance, and a baseline only on the two scripts #1549 edited: Engine Bidding version 101 (2026-09-29) holds the other two', async () => {
    // #1549 moved 1002 and 1005 into the duplicate codes in tripoint_ping and
    // build_response_body, so each carries version 101's hash until pasted; the
    // baseline must differ from the kept file, or a paste would never be awaited.
    const edited: Record<string, string> = {
      'tripoint_ping.js': 'fccee3d5a423222b246bcf46e05ac8660ffeb4208bfdc03d672794e213e0586a',
      'build_response_body.js': 'f551e90acc68d26fdb27bb81be85f4b995dce707520395a73e5c4c553b6e4b43',
    }
    for (const kept of KEPT_ENGINE_SCRIPTS) {
      expect(kept.newNodeSince, kept.file).toBeUndefined()
      if (edited[kept.file]) {
        expect(kept.canvasBaselineSha256, kept.file).toBe(edited[kept.file])
        expect(kept.baselineReadOn, kept.file).toBe('2026-09-30')
        expect(await sha256Hex(kept.script), kept.file).not.toBe(edited[kept.file])
      } else {
        expect(kept.canvasBaselineSha256, kept.file).toBeNull()
        expect(kept.baselineReadOn, kept.file).toBeNull()
      }
    }
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
      workflows: [{ name: 'Engine Bidding Workflow', workflowId: ENGINE_BIDDING_WORKFLOW_ID, folder: 'engine-bidding', scripts: [await keptFor(KEPT, BASELINE)] }],
      fetch: (async () => new Response(mirror(canvas), { status: 200 })) as unknown as typeof fetch,
      localDev: false,
      log: () => {},
      ...over,
    }
  }

  it('is skipped with no repo configured, because then there is no mirror to compare against (the backup is off)', async () => {
    const s = await runEngineScriptDrift(await deps({ repo: undefined }))
    expect(s).toEqual({ skipped: 'no_repo', verdicts: [], findings: [] })
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
  const summary = (over: Partial<DriftSummary>): DriftSummary => ({ verdicts: [], findings: [], ...over })
  const run = (s: DriftSummary) => async () => s

  it('pages the findings and clears a standing page with an empty list on a clean run', async () => {
    const notify = vi.fn(async () => {})
    await runEngineScriptDriftAndPage(run(summary({ findings: ['x drifted'] })), notify)
    expect(notify).toHaveBeenCalledWith(['x drifted'])
    await runEngineScriptDriftAndPage(run(summary({})), notify)
    expect(notify).toHaveBeenLastCalledWith([])
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
    expect(endingOf({ skipped: 'no_repo', verdicts: [], findings: [] }).outcome).toBe('skipped')
    expect(endingOf({ verdicts: [], findings: ['could not read'], unreadable: '500' }).outcome).toBe('unmeasured')
    expect(endingOf({ verdicts: [agree, drift], findings: ['c drifted'] }).outcome).toBe('findings')
    expect(endingOf({ verdicts: [agree, awaiting], findings: [] })).toMatchObject({ outcome: 'awaiting_paste', summary: { awaiting: ['W/b'] } })
    expect(endingOf({ verdicts: [agree, agree], findings: [] }).outcome).toBe('ok')
  })

  it('a workflow not built yet is listed as not_built and does not stop the run reading ok', () => {
    expect(endingOf({ verdicts: [agree, notBuilt], findings: [] })).toMatchObject({ outcome: 'ok', summary: { not_built: ['L/d'] } })
  })

  it('one unreadable mirror beside a judged workflow still records what was judged, as findings', () => {
    expect(endingOf({ verdicts: [agree], findings: ['could not read'], unreadable: 'L: 500' }).outcome).toBe('findings')
    expect(endingOf({ verdicts: [notBuilt], findings: ['could not read'], unreadable: 'W: 500' }).outcome).toBe('unmeasured')
  })

  it('lists every script and its state in the summary, so job_runs shows which paste landed', () => {
    const ending = endingOf({ verdicts: [agree, awaiting], findings: [] })
    expect(ending.summary).toMatchObject({ scripts: { 'W/a': 'agree', 'W/b': 'awaiting_paste' } })
  })
})

describe('the Liberty1 click workflow (#1545)', () => {
  const liberty1 = KEPT_CANVAS_WORKFLOWS.find((w) => w.folder === 'liberty1-click')

  it('is watched with its four kept scripts, each the file on disk, with no canvas baseline: the canvas holds all four since version 7 (2026-09-29)', () => {
    expect(liberty1?.scripts.map((k) => k.namespace)).toEqual(['resolve_input', 'pick_record', 'build_request', 'click_patch'])
    for (const kept of liberty1?.scripts ?? []) {
      expect(kept.script, kept.file).toBe(LIBERTY1_ON_DISK[kept.file])
      expect(stripTrailingWhitespace(kept.script), kept.file).toBe(kept.script)
      expect(kept.canvasBaselineSha256, kept.file).toBeNull()
      expect(kept.newNodeSince, kept.file).toBeUndefined()
    }
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
      const nodes = (liberty1?.scripts ?? []).map((k) => codeNode(k.namespace, k.script))
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
        { name: 'A flow', workflowId: 'wf-a', folder: 'a', scripts: [script('a')] },
        { name: 'B flow', workflowId: 'wf-b', folder: 'b', scripts: [script('b')] },
      ],
    })
    expect(urls.map((u) => u.split('/').pop())).toEqual(['wf-a.json', 'wf-b.json'])
    expect(s.verdicts).toEqual([{ workflow: 'A flow', namespace: 'a', file: 'a.js', state: 'agree' }])
    expect(s.findings).toHaveLength(1)
    expect(s.findings[0]).toContain('B flow')
    expect(s.unreadable).toContain('500')
  })
})
