/**
 * Pages when a kept Engine script and the canvas disagree (#1472).
 *
 * apps/worker/src/engine/scripts/engine-bidding/*.js are byte for byte what is
 * pasted into the Engine Bidding Workflow's code nodes, and the canvas is the
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
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { formatErr } from './format-error'
import { fetchGitHubFileText } from './github'
import { withJobRun, type JobRunEnding } from './job-run-record'

/** The heartbeat, job_runs and alert name. */
export const ENGINE_SCRIPT_DRIFT_JOB = 'engine-script-drift'

/** The live Engine Bidding Workflow (docs/engine-cutover-scope.md), the one canvas these scripts run on. */
export const ENGINE_BIDDING_WORKFLOW_ID = 'da82a183-1a4a-417e-b0b8-5f3fe5e14840'

export interface KeptScript {
  /** The code node's namespace on the canvas. */
  namespace: string
  /** The file under engine/scripts/engine-bidding/. */
  file: string
  /** The file's text, exactly what is pasted. */
  script: string
  /**
   * sha256 of the canvas script this kept copy was derived from, read from the
   * mirror on `baselineReadOn`. While the canvas still holds that script the
   * kept copy is a paste not yet made, not a drift. Update both fields together
   * whenever a kept file is re-derived from a newer canvas.
   */
  canvasBaselineSha256: string
  baselineReadOn: string
}

/**
 * Baselines read on 2026-09-24 from the live definition (version 100, the Stage
 * A paste of 2026-09-23): the SHA-256 of each code node's script exactly as the
 * canvas holds it, which is the kept file of PR #1470 (tripoint_ping without
 * its final newline). The kept files were then re-derived for #1416, so until
 * Stage C pastes them the check reports awaiting_paste, not drift.
 */
export const KEPT_ENGINE_SCRIPTS: readonly KeptScript[] = [
  {
    namespace: 'tripoint_ping',
    file: 'tripoint_ping.js',
    script: TRIPOINT_PING,
    canvasBaselineSha256: '9cda1574d6d2735636656615f7ad8df743afd508a182af87f7c21db28e91f2fb',
    baselineReadOn: '2026-09-24',
  },
  {
    namespace: 'build_response_body',
    file: 'build_response_body.js',
    script: BUILD_RESPONSE_BODY,
    canvasBaselineSha256: 'e9a9af5788469160f7a845473aa472f9d13c031ffb17da162245a2b90c47dd04',
    baselineReadOn: '2026-09-24',
  },
  {
    namespace: 'patch_prospect_body',
    file: 'patch_prospect_body.js',
    script: PATCH_PROSPECT_BODY,
    canvasBaselineSha256: '13d25373e7e22a26df3c9ce14e03d7a33d61cff0540a59524ae0f5d68b61e2f5',
    baselineReadOn: '2026-09-24',
  },
]

export type ScriptVerdict =
  | { namespace: string; file: string; state: 'agree' }
  | { namespace: string; file: string; state: 'awaiting_paste'; baselineReadOn: string }
  | { namespace: string; file: string; state: 'drift'; line: number; kept: string | null; canvas: string | null }
  | { namespace: string; file: string; state: 'missing_node' }

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

export async function judgeKeptScripts(kept: readonly KeptScript[], definition: { nodes?: unknown }): Promise<ScriptVerdict[]> {
  const out: ScriptVerdict[] = []
  for (const k of kept) {
    const canvas = canvasScriptFor(definition, k.namespace)
    if (canvas === null) {
      out.push({ namespace: k.namespace, file: k.file, state: 'missing_node' })
      continue
    }
    const keptText = withoutFinalNewline(k.script)
    const canvasText = withoutFinalNewline(canvas)
    if (keptText === canvasText) {
      out.push({ namespace: k.namespace, file: k.file, state: 'agree' })
      continue
    }
    if ((await sha256Hex(canvas)) === k.canvasBaselineSha256) {
      out.push({ namespace: k.namespace, file: k.file, state: 'awaiting_paste', baselineReadOn: k.baselineReadOn })
      continue
    }
    out.push({ namespace: k.namespace, file: k.file, state: 'drift', ...firstDifference(keptText, canvasText) })
  }
  return out
}

/** A quoted line for Slack: enough to recognise, never a whole script. */
const quote = (line: string | null): string => (line === null ? '(no such line)' : JSON.stringify(line.length > 120 ? `${line.slice(0, 117)}...` : line))

export function describeVerdict(v: ScriptVerdict): string {
  switch (v.state) {
    case 'drift':
      return `${v.namespace}: the canvas script differs from ${v.file} from line ${v.line}, and matches neither the kept file nor the canvas it was derived from. Kept: ${quote(v.kept)}. Canvas: ${quote(v.canvas)}.`
    case 'missing_node':
      return `${v.namespace}: the Engine Bidding Workflow has no code node with this namespace, so ${v.file} has nothing to run as.`
    case 'awaiting_paste':
      return `${v.namespace}: the canvas still holds the script ${v.file} was derived from on ${v.baselineReadOn}; the paste has not happened yet.`
    case 'agree':
      return `${v.namespace}: the canvas holds ${v.file}.`
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
  workflowId: string
  kept: readonly KeptScript[]
  fetch: typeof fetch
  localDev: boolean
  log(line: string): void
}

export interface DriftSummary {
  skipped?: 'local_dev' | 'no_repo'
  verdicts: ScriptVerdict[]
  /** The lines that page. Empty means the canvas and the repo agree, or the paste is still awaited. */
  findings: string[]
  /** Why nothing could be judged, when the mirror could not be read. */
  unreadable?: string
}

export async function runEngineScriptDrift(deps: DriftDeps): Promise<DriftSummary> {
  if (deps.localDev) {
    deps.log(`[${ENGINE_SCRIPT_DRIFT_JOB}] skipped: local dev`)
    return { skipped: 'local_dev', verdicts: [], findings: [] }
  }
  // No repo means the backup is switched off, so there is no mirror to read.
  // A repo with no token is the backup's own misconfiguration (#240) and is
  // reported the same way the backup reports it.
  if (!deps.repo) return { skipped: 'no_repo', verdicts: [], findings: [] }
  if (!deps.token) {
    const reason = 'GITHUB_TOKEN is not set while GITHUB_REPO is configured, so the mirror cannot be read'
    return { verdicts: [], findings: [`could not read the canvas mirror: ${reason}`], unreadable: reason }
  }
  const mirror = await readMirrorDefinition({ repo: deps.repo, token: deps.token, workflowId: deps.workflowId, fetch: deps.fetch })
  if (!mirror.ok) return { verdicts: [], findings: [`could not read the canvas mirror: ${mirror.reason}`], unreadable: mirror.reason }
  const verdicts = await judgeKeptScripts(deps.kept, mirror.definition)
  for (const v of verdicts) deps.log(`[${ENGINE_SCRIPT_DRIFT_JOB}] ${describeVerdict(v)}`)
  const findings = verdicts.filter((v) => v.state === 'drift' || v.state === 'missing_node').map(describeVerdict)
  return { verdicts, findings }
}

export function endingOf(summary: DriftSummary): JobRunEnding {
  if (summary.skipped) return { outcome: 'skipped', detail: summary.skipped }
  if (summary.unreadable) return { outcome: 'unmeasured', detail: summary.unreadable }
  const scripts = Object.fromEntries(summary.verdicts.map((v) => [v.namespace, v.state]))
  const awaiting = summary.verdicts.filter((v) => v.state === 'awaiting_paste').map((v) => v.namespace)
  const outcome = summary.findings.length > 0 ? 'findings' : awaiting.length > 0 ? 'awaiting_paste' : 'ok'
  return { outcome, summary: { scripts, awaiting, findings: summary.findings.length } }
}

/**
 * Only a run that judged speaks for the job: a skipped run measured nothing, so
 * it neither pages nor clears a standing page (L11).
 */
export async function runEngineScriptDriftAndPage(run: () => Promise<DriftSummary>, notify: (lines: string[]) => Promise<void>): Promise<DriftSummary> {
  const summary = await run()
  if (!summary.skipped) await notify(summary.findings)
  return summary
}

export const ENGINE_SCRIPT_DRIFT_REMEDY: AlertRemedy = {
  consequence:
    'A code node on the Engine Bidding Workflow holds a script that is neither the kept copy in apps/worker/src/engine/scripts/engine-bidding ' +
    'nor the canvas script that copy was derived from, so the repo has no copy of what is running and the tests are proving a ' +
    'script the canvas no longer runs. Bidding itself is unaffected. Each line names the node and the first line that differs:',
  fixHint:
    'Open the node named on the Engine Bidding Workflow and compare its script with the kept file. If the canvas edit is the one ' +
    'that should stand, copy the canvas script into the kept file in a PR, update its canvasBaselineSha256 in ' +
    'apps/worker/src/lib/engine-script-drift.ts, and rerun the script tests. If the kept file is right, paste it into the node and ' +
    'save. The check runs hourly and goes quiet once the two agree; a mirror it could not read is reported in its own words.',
  headlineVerb: 'found a canvas script the repo does not hold',
  itemNoun: { one: 'difference', many: 'differences' },
}

export function productionDriftDeps(env: Env): DriftDeps {
  return {
    repo: env.GITHUB_REPO,
    token: env.GITHUB_TOKEN,
    workflowId: ENGINE_BIDDING_WORKFLOW_ID,
    kept: KEPT_ENGINE_SCRIPTS,
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
        (lines) => notifyExportFailure(supabase, ENGINE_SCRIPT_DRIFT_JOB, lines, env.IDEMPOTENCY, ENGINE_SCRIPT_DRIFT_REMEDY),
      ),
    endingOf,
  )
}
