/**
 * Pages when a kept canvas script and the canvas disagree (#1472).
 *
 * apps/worker/src/engine/scripts/<folder>/*.js are byte for byte what is pasted
 * into a workflow's code nodes: engine-bidding/ for the Engine Bidding Workflow,
 * liberty1-click/ for the Liberty1 click workflow (#1545), lead-economy/ for
 * Lead Economy (#2089). KEPT_CANVAS_WORKFLOWS
 * names each folder with the workflow it runs on. The canvas is the
 * source of truth: every save mirrors the definition to the backup repo
 * (GITHUB_REPO). A canvas edit that is not mirrored back into the repo leaves
 * the tests in engine/scripts/__tests__ proving a script that no longer runs
 * (L454), and nothing said whether a paste actually landed.
 *
 * Three states per script, because "differs" alone cannot be paged on (L11,
 * L36). Until the Phase 7 paste the kept copies are deliberately AHEAD of the
 * canvas, for weeks, so each kept script records the hash of the canvas script
 * it was derived from:
 *
 *   agree           the canvas holds the kept script. Green; after a paste this
 *                   is the confirmation it landed.
 *   awaiting_paste  the canvas still holds exactly the script the kept copy was
 *                   derived from. Nobody edited anything; the paste has not
 *                   happened yet. Recorded in job_runs, never paged (L636).
 *   drift           the canvas holds something that is neither. Somebody edited
 *                   the node and the repo has no copy of what runs. Paged, with
 *                   the node, the file and the first differing line.
 *
 * The same run compares each kept workflow's outcome deciding node settings
 * with the committed definition it was built from (#1662, kept-node-config.ts),
 * and a difference pages in the same alert naming the setting and both values.
 *
 * A missing node and an unreadable mirror are findings in their own words, and
 * an unreadable mirror judges nothing rather than reading as an empty canvas
 * (L215). Runs hourly on the `0 * * * *` cron; heartbeat and job_runs name
 * `engine-script-drift`.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'
import BUILD_RESPONSE_BODY from '../engine/scripts/engine-bidding/build_response_body.js'
import PATCH_PROSPECT_BODY from '../engine/scripts/engine-bidding/patch_prospect_body.js'
import TRIPOINT_PING from '../engine/scripts/engine-bidding/tripoint_ping.js'
import KNOWN_NO_GATE from '../engine/scripts/engine-bidding/known_no_gate.js'
import RESOLVE_CLICK_INPUT from '../engine/scripts/liberty1-click/resolve_click_input.js'
import BUILD_LIBERTY1_REQUEST from '../engine/scripts/liberty1-click/build_liberty1_request.js'
import LIBERTY1_CLICK_PATCH from '../engine/scripts/liberty1-click/liberty1_click_patch.js'
import PICK_CLICK_RECORD from '../engine/scripts/liberty1-click/pick_click_record.js'
import LEAD_ECONOMY_RETURN_RESPONSE from '../engine/scripts/lead-economy/return_response.js'
import RML_LENDSWIFT_BUILD_RESPONSE from '../engine/scripts/rml-lendswift/build_response.js'
import RML_GIGFI_BUILD_RESPONSE from '../engine/scripts/rml-gigfi/build_response.js'
import BIDDING_LENDSWIFT_BUILD_RESPONSE from '../engine/scripts/bidding-lendswift/build_response.js'
import FORMS_SIGN_SUBMISSION_LINK from '../engine/scripts/forms-engine/sign_submission_link.js'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { formatErr } from './format-error'
import { fetchGitHubFileText } from './github'
import { withJobRun, type JobRunEnding } from './job-run-record'
import { describeConfigVerdict, judgeKeptConfig, type CommittedSource, type ConfigVerdict } from './kept-node-config'
import LIBERTY1_CLICK_DEFINITION from '../../../../docs/workflows/liberty1-click/definition.json'
import ENGINE_LIBERTY1_WIRING from '../../../../docs/workflows/engine-bidding/liberty1-wiring.json'
import ENGINE_BUYER_SELECT from '../../../../docs/workflows/engine-bidding/buyer-select.json'
import ENGINE_SALESFORCE_NODES from '../../../../docs/workflows/engine-bidding/salesforce-nodes.json'

/** The heartbeat, job_runs and alert name. */
export const ENGINE_SCRIPT_DRIFT_JOB = 'engine-script-drift'

/** The live Engine Bidding Workflow (docs/engine-cutover-scope.md), the one canvas these scripts run on. */
export const ENGINE_BIDDING_WORKFLOW_ID = 'da82a183-1a4a-417e-b0b8-5f3fe5e14840'

export interface KeptScript {
  /** The code node's namespace on the canvas. */
  namespace: string
  /** The file under engine/scripts/<folder>/. */
  file: string
  /** The file's text, exactly what is pasted. */
  script: string
  /**
   * sha256 of the canvas script this kept copy was derived from, read from the
   * mirror on `baselineReadOn`. While the canvas still holds that script the
   * kept copy is a paste not yet made, not a drift. Update both fields together
   * whenever a kept file is re-derived from a newer canvas. Null for a script
   * written here first, with no canvas script before it: any difference from
   * the canvas is then a drift.
   */
  canvasBaselineSha256: string | null
  baselineReadOn: string | null
  /**
   * Set only for a script written here for a node the canvas does not have yet
   * (#1544): the day it was written. While no code node carries the namespace,
   * the check records awaiting_paste (a first paste not made) instead of paging
   * missing_node. Once the node is on the canvas this changes nothing: the
   * script is judged like any other, and with no baseline any difference is a
   * drift. Remove it in the change after the paste, so a node deleted later
   * pages as missing again.
   */
  newNodeSince?: string
}

/** One workflow whose code node scripts are kept in the repo. */
export interface KeptWorkflow {
  /** Names the workflow in a page and in job_runs. */
  name: string
  /**
   * The workflow the scripts run on. Null while it has not been built on the
   * canvas, so there is no mirror to read: its scripts are recorded as
   * not_built and never paged. Set it in the change after the first save.
   */
  workflowId: string | null
  /** The folder under engine/scripts/. */
  folder: string
  scripts: readonly KeptScript[]
  /**
   * The committed files whose nodes' outcome deciding settings are compared
   * with the canvas (#1662, kept-node-config.ts). Empty judges no settings.
   */
  configSources: readonly CommittedSource[]
}

/**
 * The Engine Bidding Workflow's kept scripts. The three sale scripts were first
 * kept against the canvas of version 100 (the Stage A paste of 2026-09-23),
 * with baselines so edits made here first (#1416, #1540 and #1544) read as
 * pastes awaited rather than drift, and known_no_gate (#1544) as a new node.
 *
 * All four were saved to the live workflow as version 101 on 2026-09-29 and the
 * hourly check read each as agree, so none carries a baseline any more: any
 * difference from the canvas is a drift, and a missing node pages as missing.
 * To edit one here before its paste again, record the live canvas script's hash
 * as its baseline in the same change.
 *
 * #1549 edited tripoint_ping and build_response_body (the duplicate result codes
 * became 1002 to 1005 and 1020); both were pasted as version 103 on 2026-09-30,
 * so neither carries a baseline again. #1653 edited known_no_gate, pasted as
 * version 106 on 2026-10-02, so none of the four carries one.
 *
 * #2089 edited build_response_body here first (the signed link token on the offer
 * link). Dan pasted it on 2026-10-14 (2:25 PM ET) and the hourly check read it as
 * agree, so its baseline was cleared (#2093): a canvas put back to the script
 * before #2089, which sends every offer link out unsigned, pages as a drift.
 *
 * #2092 edited build_response_body here first again: the link token block became
 * one text shared with five other scripts, its host list moved just above it, and a
 * missing secret now logs an error. Nothing it sends changes. Its baseline is the
 * #2089 canvas script, read from the mirror on 2026-10-15; clear it once the paste
 * reads as agree.
 *
 * tripoint_ping was edited here first on 2026-10-15: it applies Tripoint's 2,000
 * minimum loan amount, refusing a smaller or unreadable loan before anything is
 * sent. Its baseline is the canvas script as it stood, read from the live
 * definition on 2026-10-15; clear it once the paste reads as agree.
 */
export const KEPT_ENGINE_SCRIPTS: readonly KeptScript[] = [
  {
    namespace: 'tripoint_ping',
    file: 'tripoint_ping.js',
    script: TRIPOINT_PING,
    canvasBaselineSha256: 'd2e52b089e89e546ded01fd67bfdbda22147b8945134db2c0be4cae4273a5afb',
    baselineReadOn: '2026-10-15',
  },
  {
    namespace: 'build_response_body',
    file: 'build_response_body.js',
    script: BUILD_RESPONSE_BODY,
    canvasBaselineSha256: 'f94b7262c098c497639d110674158bdbc37056d0ab0ca90144ff1f3ba4710d9c',
    baselineReadOn: '2026-10-15',
  },
  {
    namespace: 'patch_prospect_body',
    file: 'patch_prospect_body.js',
    script: PATCH_PROSPECT_BODY,
    canvasBaselineSha256: null,
    baselineReadOn: null,
  },
  // The known no gate (#1544). #1653's edit was pasted as version 106 on 2026-10-02.
  {
    namespace: 'known_no_gate',
    file: 'known_no_gate.js',
    script: KNOWN_NO_GATE,
    canvasBaselineSha256: null,
    baselineReadOn: null,
  },
]

/**
 * The Liberty1 click workflow (#1545), which replaces Brian's Pipedream flow,
 * built from docs/workflows/liberty1-click/definition.json and first saved on
 * 2026-09-25 (#1547) as "Liberty1 Click Handler". The scripts were written here
 * first, so they had no canvas baseline.
 *
 * On 2026-09-29 Brian's Pipedream flow moved back to the Liberty1 Salesforce
 * site and learned Submission-only clicks; resolve_input and build_request were
 * re-derived here for it, pick_record was added, and the result was saved to the
 * workflow as version 7 the same day.
 *
 * On 2026-09-30 Dan moved the clicks back to Liberty1's LeadConnector triggers on
 * the canvas (build_request at version 11, click_send's success line at 12), and
 * build_liberty1_request.js was re-derived from version 12.
 *
 * #1671 then took the routes out of build_liberty1_request.js here first (the
 * buyer profile's click delivery picks the route since #1639), and Dan pasted it
 * as version 15 on 2026-09-30 (19:54 UTC). The canvas holds all four files, so
 * none has a baseline: any difference is a drift.
 */
export const LIBERTY1_CLICK_WORKFLOW_ID: string | null = '8a0f65aa-49a9-441c-a47e-b2a9a5fb2b08'

export const KEPT_LIBERTY1_CLICK_SCRIPTS: readonly KeptScript[] = [
  { namespace: 'resolve_input', file: 'resolve_click_input.js', script: RESOLVE_CLICK_INPUT, canvasBaselineSha256: null, baselineReadOn: null },
  { namespace: 'pick_record', file: 'pick_click_record.js', script: PICK_CLICK_RECORD, canvasBaselineSha256: null, baselineReadOn: null },
  { namespace: 'build_request', file: 'build_liberty1_request.js', script: BUILD_LIBERTY1_REQUEST, canvasBaselineSha256: null, baselineReadOn: null },
  { namespace: 'click_patch', file: 'liberty1_click_patch.js', script: LIBERTY1_CLICK_PATCH, canvasBaselineSha256: null, baselineReadOn: null },
]

/**
 * Lead Economy (#2089), which builds the same trypennie.com offer links as the
 * Engine Bidding Workflow in its return_response code node. Only that script is
 * kept: it was copied from the mirror on 2026-10-14 and the signed link token
 * added here. Dan pasted it the same day (2:27 PM ET) and the hourly check read it
 * as agree (#2093). #2092 then edited it here first (the shared link token block,
 * as in build_response_body; nothing it sends changes), so it carries the #2089
 * canvas script as its baseline until that paste reads as agree. No settings are
 * committed for this workflow, so none are judged.
 */
export const LEAD_ECONOMY_WORKFLOW_ID = '89b1a6af-7e0f-43de-bc66-1e888184551f'

export const KEPT_LEAD_ECONOMY_SCRIPTS: readonly KeptScript[] = [
  {
    namespace: 'return_response',
    file: 'return_response.js',
    script: LEAD_ECONOMY_RETURN_RESPONSE,
    canvasBaselineSha256: '6703c65ac140cf1671ba039da05e6657e3cb9b72dcc3ac7d11ce545650763219',
    baselineReadOn: '2026-10-15',
  },
]

/**
 * The three RML bidding flows (#2092). Each builds the reservemyloan.com offer
 * link, `<pennieClickUrl>/<Applicant id>`, in its build_response code node and
 * returns it only in the bid response. Each script was copied from the mirror on
 * 2026-10-15 and the signed link token added here, so each carries the canvas
 * script it was derived from as its baseline until its paste reads as agree. No
 * settings are committed for these workflows, so none are judged.
 */
export const KEPT_RML_LENDSWIFT_SCRIPTS: readonly KeptScript[] = [
  { namespace: 'build_response', file: 'build_response.js', script: RML_LENDSWIFT_BUILD_RESPONSE, canvasBaselineSha256: '8819c1c66705cec08f4ac1ae833b30965e0e9551843a9705a469bf7d96c129ef', baselineReadOn: '2026-10-15' },
]
export const KEPT_RML_GIGFI_SCRIPTS: readonly KeptScript[] = [
  { namespace: 'build_response', file: 'build_response.js', script: RML_GIGFI_BUILD_RESPONSE, canvasBaselineSha256: 'b5c6cc8fa7d1321c06fc611402c3408143c282697a45bf60d799cfee60e61947', baselineReadOn: '2026-10-15' },
]
export const KEPT_BIDDING_LENDSWIFT_SCRIPTS: readonly KeptScript[] = [
  { namespace: 'build_response', file: 'build_response.js', script: BIDDING_LENDSWIFT_BUILD_RESPONSE, canvasBaselineSha256: '3c8d337855ad9106e10f4fa55639e016dd279ba0d0952eca4ad936a738058ca4', baselineReadOn: '2026-10-15' },
]

/**
 * Forms <> Engine <> Data Store (Loan only) (#2092). The agent's Slack message
 * carries the submit link, which a webhook node cannot sign, so the new code node
 * sign_submission_link builds it; docs/workflows/forms-engine/definition.json is
 * the whole workflow with that node in place. It is a node the canvas does not
 * have yet, so it is awaited rather than missing until the paste; remove
 * newNodeSince in the change after it reads as agree. No settings are judged.
 */
export const KEPT_FORMS_ENGINE_SCRIPTS: readonly KeptScript[] = [
  { namespace: 'sign_submission_link', file: 'sign_submission_link.js', script: FORMS_SIGN_SUBMISSION_LINK, canvasBaselineSha256: null, baselineReadOn: null, newNodeSince: '2026-10-15' },
]

/**
 * The committed settings of the Engine Bidding Workflow (#1662). No full
 * definition of it is committed: the #1544 wiring holds the nodes it added
 * (route_known_no and buyer_click_check are judged), buyer-select.json holds
 * buyer_select as the canvas ran it on 2026-09-30, the first committed copy, and
 * salesforce-nodes.json holds every salesforce node as version 104 ran them
 * (create_prospect, prospect_trades, patch_prospect, patch_prospect_reject, #1666).
 */
export const ENGINE_CONFIG_SOURCES: readonly CommittedSource[] = [
  { file: 'docs/workflows/engine-bidding/liberty1-wiring.json', nodes: ENGINE_LIBERTY1_WIRING.add_nodes },
  { file: 'docs/workflows/engine-bidding/buyer-select.json', nodes: ENGINE_BUYER_SELECT.nodes },
  { file: 'docs/workflows/engine-bidding/salesforce-nodes.json', nodes: ENGINE_SALESFORCE_NODES.nodes },
]

/** The Liberty1 click workflow's committed settings: the definition it was built from, every node of it. */
export const LIBERTY1_CLICK_CONFIG_SOURCES: readonly CommittedSource[] = [
  { file: 'docs/workflows/liberty1-click/definition.json', nodes: LIBERTY1_CLICK_DEFINITION.definition.nodes },
]

/** Every workflow the check watches, each with its folder of kept scripts and its committed settings. */
export const KEPT_CANVAS_WORKFLOWS: readonly KeptWorkflow[] = [
  { name: 'Engine Bidding Workflow', workflowId: ENGINE_BIDDING_WORKFLOW_ID, folder: 'engine-bidding', scripts: KEPT_ENGINE_SCRIPTS, configSources: ENGINE_CONFIG_SOURCES },
  { name: 'Liberty1 click workflow', workflowId: LIBERTY1_CLICK_WORKFLOW_ID, folder: 'liberty1-click', scripts: KEPT_LIBERTY1_CLICK_SCRIPTS, configSources: LIBERTY1_CLICK_CONFIG_SOURCES },
  { name: 'Lead Economy', workflowId: LEAD_ECONOMY_WORKFLOW_ID, folder: 'lead-economy', scripts: KEPT_LEAD_ECONOMY_SCRIPTS, configSources: [] },
  { name: 'RML - Bidding Workflow (LendSwift)', workflowId: 'e1b810da-16c0-49eb-bf12-ba1c9b67c914', folder: 'rml-lendswift', scripts: KEPT_RML_LENDSWIFT_SCRIPTS, configSources: [] },
  { name: 'RML - Bidding Workflow (GigFi)', workflowId: '6624acd0-bf61-4d21-85fc-4371ca7ed77d', folder: 'rml-gigfi', scripts: KEPT_RML_GIGFI_SCRIPTS, configSources: [] },
  { name: 'Bidding - LendSwift', workflowId: '0f4df7a7-2405-4fc7-9af4-5d5e05ce96c5', folder: 'bidding-lendswift', scripts: KEPT_BIDDING_LENDSWIFT_SCRIPTS, configSources: [] },
  { name: 'Forms <> Engine <> Data Store (Loan only)', workflowId: 'ff1a9f52-7346-452a-bab7-af9f95d36dda', folder: 'forms-engine', scripts: KEPT_FORMS_ENGINE_SCRIPTS, configSources: [] },
]

type VerdictBase = { workflow: string; namespace: string; file: string }
export type ScriptVerdict =
  | (VerdictBase & { state: 'agree' })
  | (VerdictBase & { state: 'awaiting_paste'; baselineReadOn: string; newNode?: true })
  | (VerdictBase & { state: 'drift'; line: number; kept: string | null; canvas: string | null })
  | (VerdictBase & { state: 'missing_node' })
  | (VerdictBase & { state: 'not_built' })

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The one normalisation: a file in git ends with a newline and a script box's
 * value need not, so the final newline run is not a difference. Nothing else is
 * forgiven, because the kept file is by definition the paste (L273).
 */
const withoutFinalNewline = (s: string): string => s.replace(/[\r\n]+$/, '')

interface CanvasNodeLike {
  namespace?: unknown
  type?: unknown
  config?: { script?: unknown } | null
}

function canvasScriptFor(definition: { nodes?: unknown }, namespace: string): string | null {
  const nodes = Array.isArray(definition.nodes) ? (definition.nodes as CanvasNodeLike[]) : []
  const node = nodes.find((n) => n.type === 'code' && n.namespace === namespace)
  if (!node) return null
  const script = node.config?.script
  return typeof script === 'string' ? script : ''
}

function firstDifference(kept: string, canvas: string): { line: number; kept: string | null; canvas: string | null } {
  const k = kept.split('\n')
  const c = canvas.split('\n')
  const n = Math.max(k.length, c.length)
  for (let i = 0; i < n; i++) {
    const a = i < k.length ? k[i] : null
    const b = i < c.length ? c[i] : null
    if (a !== b) return { line: i + 1, kept: a, canvas: b }
  }
  // Only reachable if the two are equal, which the caller has ruled out.
  return { line: n, kept: null, canvas: null }
}

export async function judgeKeptScripts(kept: readonly KeptScript[], definition: { nodes?: unknown }, workflow: string): Promise<ScriptVerdict[]> {
  const out: ScriptVerdict[] = []
  for (const k of kept) {
    const base = { workflow, namespace: k.namespace, file: k.file }
    const canvas = canvasScriptFor(definition, k.namespace)
    if (canvas === null) {
      if (k.newNodeSince) out.push({ ...base, state: 'awaiting_paste', baselineReadOn: k.newNodeSince, newNode: true })
      else out.push({ ...base, state: 'missing_node' })
      continue
    }
    const keptText = withoutFinalNewline(k.script)
    const canvasText = withoutFinalNewline(canvas)
    if (keptText === canvasText) {
      out.push({ ...base, state: 'agree' })
      continue
    }
    if (k.canvasBaselineSha256 !== null && (await sha256Hex(canvas)) === k.canvasBaselineSha256) {
      out.push({ ...base, state: 'awaiting_paste', baselineReadOn: k.baselineReadOn ?? 'an unrecorded day' })
      continue
    }
    out.push({ ...base, state: 'drift', ...firstDifference(keptText, canvasText) })
  }
  return out
}

/** A quoted line for Slack: enough to recognise, never a whole script. */
const quote = (line: string | null): string => (line === null ? '(no such line)' : JSON.stringify(line.length > 120 ? `${line.slice(0, 117)}...` : line))

export function describeVerdict(v: ScriptVerdict): string {
  switch (v.state) {
    case 'drift':
      return `${v.workflow}, ${v.namespace}: the canvas script differs from ${v.file} from line ${v.line}, and matches neither the kept file nor the canvas it was derived from. Kept: ${quote(v.kept)}. Canvas: ${quote(v.canvas)}.`
    case 'missing_node':
      return `${v.workflow}, ${v.namespace}: the workflow has no code node with this namespace, so ${v.file} has nothing to run as.`
    case 'awaiting_paste':
      if (v.newNode) return `${v.workflow}, ${v.namespace}: the canvas has no such node yet; ${v.file} was written for it on ${v.baselineReadOn} and awaits its first paste.`
      return `${v.workflow}, ${v.namespace}: the canvas still holds the script ${v.file} was derived from on ${v.baselineReadOn}; the paste has not happened yet.`
    case 'agree':
      return `${v.workflow}, ${v.namespace}: the canvas holds ${v.file}.`
    case 'not_built':
      return `${v.workflow}, ${v.namespace}: no workflow id is recorded yet, so ${v.file} is compared with no canvas.`
  }
}

export type MirrorRead = { ok: true; definition: { nodes?: unknown } } | { ok: false; reason: string }

export async function readMirrorDefinition(deps: { repo: string; token: string; workflowId: string; fetch: typeof fetch }): Promise<MirrorRead> {
  const read = await fetchGitHubFileText(deps.repo, `workflows/${deps.workflowId}.json`, deps.token, deps.fetch)
  if (!read.ok) return read
  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch (err) {
    return { ok: false, reason: `the mirror file is not JSON: ${formatErr(err)}` }
  }
  const definition = (parsed as { definition?: unknown } | null)?.definition
  if (!definition || typeof definition !== 'object') return { ok: false, reason: 'the mirror file carries no definition object' }
  return { ok: true, definition }
}

export interface DriftDeps {
  repo: string | undefined
  token: string | undefined
  workflows: readonly KeptWorkflow[]
  fetch: typeof fetch
  localDev: boolean
  log(line: string): void
}

export interface DriftSummary {
  skipped?: 'local_dev' | 'no_repo'
  verdicts: ScriptVerdict[]
  /** The committed node settings against the canvas (#1662), judged in the same run. */
  configVerdicts: ConfigVerdict[]
  /** The lines that page. Empty means the canvas and the repo agree, or the paste is still awaited. */
  findings: string[]
  /** Why nothing could be judged, when the mirror could not be read. */
  unreadable?: string
}

export async function runEngineScriptDrift(deps: DriftDeps): Promise<DriftSummary> {
  if (deps.localDev) {
    deps.log(`[${ENGINE_SCRIPT_DRIFT_JOB}] skipped: local dev`)
    return { skipped: 'local_dev', verdicts: [], configVerdicts: [], findings: [] }
  }
  // No repo means the backup is switched off, so there is no mirror to read.
  // A repo with no token is the backup's own misconfiguration (#240) and is
  // reported the same way the backup reports it.
  if (!deps.repo) return { skipped: 'no_repo', verdicts: [], configVerdicts: [], findings: [] }
  if (!deps.token) {
    const reason = 'GITHUB_TOKEN is not set while GITHUB_REPO is configured, so the mirror cannot be read'
    return { verdicts: [], configVerdicts: [], findings: [`could not read the canvas mirror: ${reason}`], unreadable: reason }
  }
  const verdicts: ScriptVerdict[] = []
  const configVerdicts: ConfigVerdict[] = []
  const unreadableFindings: string[] = []
  const unreadable: string[] = []
  for (const w of deps.workflows) {
    if (w.workflowId === null) {
      for (const k of w.scripts) verdicts.push({ workflow: w.name, namespace: k.namespace, file: k.file, state: 'not_built' })
      continue
    }
    // One workflow's unreadable mirror judges nothing for THAT workflow and is
    // its own finding; the others are still judged (L11, L215).
    const mirror = await readMirrorDefinition({ repo: deps.repo, token: deps.token, workflowId: w.workflowId, fetch: deps.fetch })
    if (!mirror.ok) {
      unreadable.push(`${w.name}: ${mirror.reason}`)
      unreadableFindings.push(`could not read the canvas mirror of the ${w.name}: ${mirror.reason}`)
      continue
    }
    verdicts.push(...(await judgeKeptScripts(w.scripts, mirror.definition, w.name)))
    configVerdicts.push(...judgeKeptConfig(w.configSources, mirror.definition, w.name))
  }
  for (const v of verdicts) deps.log(`[${ENGINE_SCRIPT_DRIFT_JOB}] ${describeVerdict(v)}`)
  for (const v of configVerdicts) deps.log(`[${ENGINE_SCRIPT_DRIFT_JOB}] ${describeConfigVerdict(v)}`)
  const findings = [
    ...unreadableFindings,
    ...verdicts.filter((v) => v.state === 'drift' || v.state === 'missing_node').map(describeVerdict),
    ...configVerdicts.filter((v) => v.state !== 'agree').map(describeConfigVerdict),
  ]
  return { verdicts, configVerdicts, findings, ...(unreadable.length > 0 ? { unreadable: unreadable.join('; ') } : {}) }
}

export function endingOf(summary: DriftSummary): JobRunEnding {
  if (summary.skipped) return { outcome: 'skipped', detail: summary.skipped }
  const judged = [...summary.verdicts.filter((v) => v.state !== 'not_built'), ...summary.configVerdicts]
  if (summary.unreadable && judged.length === 0) return { outcome: 'unmeasured', detail: summary.unreadable }
  const key = (v: { workflow: string; namespace: string }) => `${v.workflow}/${v.namespace}`
  const scripts = Object.fromEntries(summary.verdicts.map((v) => [key(v), v.state]))
  const awaiting = summary.verdicts.filter((v) => v.state === 'awaiting_paste').map(key)
  const notBuilt = summary.verdicts.filter((v) => v.state === 'not_built').map(key)
  // One state per node: agree only when every watched setting agrees, else the first finding's.
  const config: Record<string, ConfigVerdict['state']> = {}
  for (const v of summary.configVerdicts) {
    const k = key(v)
    if (config[k] === undefined || config[k] === 'agree') config[k] = v.state
  }
  const outcome = summary.findings.length > 0 ? 'findings' : awaiting.length > 0 ? 'awaiting_paste' : 'ok'
  return { outcome, summary: { scripts, config, awaiting, not_built: notBuilt, findings: summary.findings.length } }
}

/**
 * Only a run that judged speaks for the job: a skipped run measured nothing, so
 * it neither pages nor clears a standing page (L11).
 */
export async function runEngineScriptDriftAndPage(run: () => Promise<DriftSummary>, notify: (lines: string[], remedy: AlertRemedy) => Promise<void>): Promise<DriftSummary> {
  const summary = await run()
  if (!summary.skipped) await notify(summary.findings, driftRemedyFor(summary))
  return summary
}

/** The How to fix sentence for each kind of finding, joined for the kinds a run made (L111). */
const FIX_SCRIPT =
  'Open the node named on the workflow named and compare its script with the kept file. If the canvas edit is the one ' +
  'that should stand, copy the canvas script into the kept file in a PR, update its canvasBaselineSha256 in ' +
  'apps/worker/src/lib/engine-script-drift.ts, and rerun the script tests. If the kept file is right, paste it into the node and save.'
const FIX_SETTING =
  'For a setting, if the canvas value is the one that should stand, copy it into the committed file the line names in a PR; ' +
  'if the file is right, set it back on the node and save.'
// A retired setting decides nothing, so the repo is right by construction and the
// only change that clears it is taking it off the node (#1671).
const FIX_RETIRED =
  'For a setting the node no longer reads, remove it from the node on the canvas as its line says, then save the workflow; ' +
  'the repo already holds the right thing.'
// A node that is not there, or is another type now, has nothing to copy back (#835).
const FIX_MISSING =
  'For a node the workflow no longer has under that name, or one whose type changed, find whether it was renamed, removed or ' +
  'replaced on the canvas: put it back and save if it should be there, or move the kept file or committed definition to the new node in a PR.'
// A mirror that could not be read compared nothing for that workflow (#835).
const FIX_UNREADABLE =
  'Where the canvas mirror could not be read, nothing was compared for that workflow: fix what the error names, most often the ' +
  'GitHub token or the backup repo.'
const FIX_CLOSE = 'The check runs hourly and goes quiet once the two agree.'

type FixKind = 'script' | 'setting' | 'retired' | 'missing' | 'unreadable'
const FIX_ORDER: readonly FixKind[] = ['script', 'setting', 'retired', 'missing', 'unreadable']
const FIX_FOR: Record<FixKind, string> = { script: FIX_SCRIPT, setting: FIX_SETTING, retired: FIX_RETIRED, missing: FIX_MISSING, unreadable: FIX_UNREADABLE }

function fixHintFor(kinds: readonly FixKind[]): string {
  return [...FIX_ORDER.filter((k) => kinds.includes(k)).map((k) => FIX_FOR[k]), FIX_CLOSE].join(' ')
}

/** Every kind, for the reviewed remedy list; a page carries only the fixes its findings need. */
export const ENGINE_SCRIPT_DRIFT_REMEDY: AlertRemedy = {
  consequence:
    'A kept workflow on the canvas holds a code node script, or an outcome deciding node setting, that the repo does not hold: ' +
    'a script that is neither the kept copy in apps/worker/src/engine/scripts/<folder> nor the canvas script that copy was derived from, ' +
    'a setting that differs from the committed definition under docs/workflows, a setting the node no longer reads, or a node the ' +
    'repo names that the canvas no longer has as it was. The repo then does not describe what is running. The workflow itself is ' +
    'unaffected. Each line names the workflow, the node, and the first line or the setting that differs, with the values:',
  fixHint: fixHintFor(FIX_ORDER),
  headlineVerb: 'found a canvas script or node setting the repo does not hold',
  itemNoun: { one: 'difference', many: 'differences' },
}

/** A run whose only findings are mirrors it could not read: it compared nothing there, so it found no difference (#835). */
export const ENGINE_SCRIPT_DRIFT_UNREADABLE_REMEDY: AlertRemedy = {
  consequence:
    'The canvas mirror of a kept workflow could not be read, so its scripts and node settings were not compared with the repo this hour:',
  fixHint: `${FIX_UNREADABLE} ${FIX_CLOSE}`,
  headlineVerb: 'could not read a canvas mirror',
}

/**
 * The remedy for one run, its How to fix line built from the kinds of finding
 * the run made, so a page holding only a retired setting never tells anyone to
 * copy the canvas value into the repo or set it back on the node (L111), and a
 * node that is gone or a mirror that was not read never gets the copy and
 * paste fix (#835).
 */
export function driftRemedyFor(summary: DriftSummary): AlertRemedy {
  const kinds = new Set<FixKind>()
  for (const v of summary.verdicts) {
    if (v.state === 'drift') kinds.add('script')
    else if (v.state === 'missing_node') kinds.add('missing')
  }
  for (const v of summary.configVerdicts) {
    if (v.state === 'retired_setting') kinds.add('retired')
    else if (v.state === 'missing_node' || v.state === 'type_changed') kinds.add('missing')
    else if (v.state !== 'agree') kinds.add('setting')
  }
  if (summary.unreadable) kinds.add('unreadable')
  if (kinds.size === 0) return ENGINE_SCRIPT_DRIFT_REMEDY
  if (kinds.size === 1 && kinds.has('unreadable')) return ENGINE_SCRIPT_DRIFT_UNREADABLE_REMEDY
  return { ...ENGINE_SCRIPT_DRIFT_REMEDY, fixHint: fixHintFor([...kinds]) }
}

export function productionDriftDeps(env: Env): DriftDeps {
  return {
    repo: env.GITHUB_REPO,
    token: env.GITHUB_TOKEN,
    workflows: KEPT_CANVAS_WORKFLOWS,
    fetch: (input, init) => fetch(input, init),
    localDev: Boolean(env.LOCAL_DEV),
    log: (line) => console.log(line),
  }
}

export function runEngineScriptDriftForEnv(supabase: SupabaseClient, env: Env): Promise<DriftSummary> {
  return withJobRun(
    supabase,
    ENGINE_SCRIPT_DRIFT_JOB,
    () =>
      runEngineScriptDriftAndPage(
        () => runEngineScriptDrift(productionDriftDeps(env)),
        (lines, remedy) => notifyExportFailure(supabase, ENGINE_SCRIPT_DRIFT_JOB, lines, env.IDEMPOTENCY, remedy),
      ),
    endingOf,
  )
}
