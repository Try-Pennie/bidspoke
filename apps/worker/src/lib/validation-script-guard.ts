/**
 * Daily guard against a lead validation script coming back (#2595, part of #934).
 *
 * WHY. Phase 5 of #934 replaces each bidding workflow's hand written
 * `validate_bidding_and_state` code node with the first class Lead Validation
 * step, whose checks and reasons are set on the canvas, reported per reason and
 * held to the shared vocabulary. Once a workflow has swapped (RML GigFi since its
 * v25, RML LendSwift since its v26), nothing stopped somebody pasting a script back in and quietly undoing
 * all of that. This reads every active workflow's saved definition once a day
 * and reports a code node that still does the validation step's job.
 *
 * WHAT IT MATCHES. Behaviour, not the namespace spelling: a code node is flagged
 * when its script BOTH has a `status: 'rejected'` property (any quote style, on
 * the key and on the value) AND contains a quoted string equal to one of the
 * lead validation reasons. Reading every quoted string, rather than only a
 * `reason:` property, is what catches `const reason = '...'; return { reason }`.
 * Whole line comments are skipped, so a reason named in a note is not a finding.
 *
 * The reasons are `LEAD_REJECTION_REASONS` minus `unqualified_lead`, derived from
 * the list rather than copied, so a reason added to the vocabulary is looked for
 * from that day. `unqualified_lead` is left out because the response and credit
 * report scripts send it too (GigFi's build_response, Engine Bidding's
 * equifax_credit_report), and counting it would flag every one of them.
 *
 * BLIND SPOT, named on purpose: a validation script whose ONLY reason is
 * `unqualified_lead` is not caught. Nothing in the script tells it apart from a
 * response script, and the test pins that this is not caught so it stays a
 * recorded decision rather than a surprise.
 *
 * EXCEPTIONS. The workflows not yet swapped are listed in
 * KNOWN_VALIDATION_SCRIPTS by workflow id and step, each with the issue that
 * ends it. A listed node is still counted and logged but does not page. An
 * exception that matches no flagged node is its own finding, so the list cannot
 * go stale silently once a swap lands (L65, L96).
 *
 * WHAT IT READS. Active, undeleted workflows only, through the shared
 * `readActiveWorkflows` (paged past PostgREST's 1,000 row cap): a switched off
 * workflow runs nothing. A failed read, or one returning no workflows, pages as
 * its own line and judges no exception stale (L98). A clean run sends an empty
 * list, which stands a standing page down.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { LEAD_REJECTION_REASONS } from '@bidspoke/workflow-definition'
import type { Env } from '../index'
import { readActiveWorkflows } from './active-workflows'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { formatErr } from './format-error'
import { withJobRun, type JobRunEnding } from './job-run-record'

export const VALIDATION_SCRIPT_GUARD_JOB = 'validation-script-guard'

/**
 * The one reason a validation script shares with the response and credit report
 * scripts, so it cannot identify a validation script. Named once; the test
 * asserts it is on the vocabulary, so a respelling there cannot leave this
 * excluding nothing.
 */
export const SHARED_REJECTION_REASON = 'unqualified_lead'

/** The reasons only a lead validation step sends: the vocabulary minus the shared one. */
export const VALIDATION_REASONS: readonly string[] = LEAD_REJECTION_REASONS.filter((r) => r !== SHARED_REJECTION_REASON)

const VALIDATION_REASON_SET: ReadonlySet<string> = new Set(VALIDATION_REASONS)

/** A workflow allowed to keep its validation script until the issue named swaps it. */
export interface ValidationScriptException {
  workflowId: string
  /** The code node's namespace, the step name an author sees on the canvas. */
  namespace: string
  /** The workflow's name, for the stale line: an exception that matches nothing has no row to name it from. */
  label: string
  /** The issue whose swap ends this exception, e.g. `#2593`. */
  endedBy: string
}

export const KNOWN_VALIDATION_SCRIPTS: readonly ValidationScriptException[] = [
  { workflowId: '89b1a6af-7e0f-43de-bc66-1e888184551f', namespace: 'validate_bidding_and_state', label: 'Lead Economy - Bidding Workflow', endedBy: '#2594' },
  // No swap issue exists for Engine Bidding yet; its swap waits on #1414.
  { workflowId: 'da82a183-1a4a-417e-b0b8-5f3fe5e14840', namespace: 'validate_bidding_and_state', label: 'Engine Bidding Workflow', endedBy: '#1414' },
]

/**
 * What the alert says (L399). It carries three cases, a script found, an
 * exception gone stale and a scan that could not run, so the headline names
 * none of them and the lines below say which.
 */
export const VALIDATION_SCRIPT_REMEDY: AlertRemedy = {
  consequence:
    'A workflow was found rejecting leads from a code node with the lead validation reasons, a known exception ' +
    'no longer matches anything, or the check could not read the workflows. For a reported node nothing failed ' +
    'and nothing is missing: this is about how a workflow is built. The lines below say which case this is:',
  fixHint:
    'For a reported node: open that workflow on the canvas, move its checks into a Lead Validation step and delete ' +
    'the script. For a stale exception: remove it from KNOWN_VALIDATION_SCRIPTS in validation-script-guard.ts. ' +
    'For a check that could not run: the check itself needs attention, not any workflow.',
  headlineVerb: 'has findings',
  itemNoun: { one: 'finding', many: 'findings' },
}

export interface ValidationScript {
  namespace: string
  nodeId: string
  /** The validation reasons the script names, each once, in the order first named. */
  reasons: string[]
}

export interface ValidationScriptFinding extends ValidationScript {
  workflowId: string
  workflowName: string
}

/** A `status` key set to `rejected`, with or without quotes on either side. */
const STATUS_REJECTED = /(?<![\w$])(["'`]?)status\1\s*:\s*(["'`])rejected\2/
/** A string in single, double or back quotes on one line. */
const QUOTED = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g

/**
 * Live definitions keep `type` and `namespace` flat on the node and the code at
 * `config.script`; the React Flow shape (`data.*`) and `code` are read too, as
 * payload-print-scan.ts reads them.
 */
interface NodeLike {
  id?: unknown
  namespace?: unknown
  type?: unknown
  config?: { script?: unknown; code?: unknown }
  data?: { namespace?: unknown; type?: unknown; config?: { script?: unknown; code?: unknown } }
}

export function findValidationScripts(definition: unknown): ValidationScript[] {
  const nodes = (definition as { nodes?: unknown } | null)?.nodes
  if (!Array.isArray(nodes)) return []

  const out: ValidationScript[] = []
  for (const raw of nodes as NodeLike[]) {
    if (!raw || typeof raw !== 'object') continue
    const type = raw.type ?? raw.data?.type
    if (type !== 'code') continue
    const cfg = raw.config ?? raw.data?.config
    const code = cfg?.script ?? cfg?.code
    if (typeof code !== 'string') continue

    // A whole line comment is not running, so neither its status nor its
    // quoted words count.
    const lines = code.split('\n').filter((l) => {
      const t = l.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    if (!lines.some((l) => STATUS_REJECTED.test(l))) continue

    const reasons: string[] = []
    for (const line of lines) {
      for (const m of line.matchAll(QUOTED)) {
        const value = m[2]
        if (VALIDATION_REASON_SET.has(value) && !reasons.includes(value)) reasons.push(value)
      }
    }
    if (reasons.length === 0) continue

    const nodeId = typeof raw.id === 'string' ? raw.id : ''
    const ns = raw.namespace ?? raw.data?.namespace
    out.push({ namespace: typeof ns === 'string' ? ns : nodeId, nodeId, reasons })
  }
  return out
}

export interface ValidationScriptCheckResult {
  /** Every node flagged, excepted or not, so an excepted one is never lost from the log. */
  findings: ValidationScriptFinding[]
  /** The flagged nodes not on the exception list. These page. */
  newFindings: ValidationScriptFinding[]
  /** Exceptions matching no flagged node in a complete read. These page too. */
  staleExceptions: ValidationScriptException[]
  /** Non-empty when the definitions could not be read. Its own condition (L98). */
  unreadable: string[]
  /** How many workflows were read. */
  scanned: number
  alerted: boolean
}

type WorkflowRow = { id: string; name: string; definition: unknown }

export interface ValidationScriptCheckDeps {
  readWorkflows?: () => Promise<WorkflowRow[]>
  exceptions?: readonly ValidationScriptException[]
  /** Injected so a test asserts WHAT would be sent, not just that nothing threw. */
  notify?: (messages: string[], remedy: AlertRemedy) => Promise<void>
}

const isException = (f: ValidationScriptFinding, e: ValidationScriptException) =>
  e.workflowId === f.workflowId && e.namespace === f.namespace

export async function checkValidationScripts(
  env: { IDEMPOTENCY?: unknown },
  supabase: SupabaseClient,
  deps: ValidationScriptCheckDeps = {},
): Promise<ValidationScriptCheckResult> {
  const exceptions = deps.exceptions ?? KNOWN_VALIDATION_SCRIPTS
  const readWorkflows =
    deps.readWorkflows ??
    (() => readActiveWorkflows<WorkflowRow>(supabase, 'id, name, definition', 'active workflow definitions read'))

  const unreadable: string[] = []
  const findings: ValidationScriptFinding[] = []
  let scanned = 0

  try {
    const rows = await readWorkflows()
    scanned = rows.length
    if (rows.length === 0) {
      // Zero active workflows is a read that found nothing, never a clean
      // bill of health: this account always has some (L98).
      unreadable.push('no workflows were returned, so nothing was actually scanned')
    }
    for (const row of rows) {
      for (const hit of findValidationScripts(row.definition)) {
        findings.push({ ...hit, workflowId: row.id, workflowName: row.name })
      }
    }
  } catch (err) {
    unreadable.push(`the workflow definitions could not be read: ${formatErr(err)}`)
  }

  const newFindings = findings.filter((f) => !exceptions.some((e) => isException(f, e)))
  // Staleness is judged only on a complete read: a failed or empty one would
  // otherwise report every exception as ended.
  const staleExceptions =
    unreadable.length > 0 ? [] : exceptions.filter((e) => !findings.some((f) => isException(f, e)))

  const messages = [
    ...unreadable.map((u) => `Validation script check could not run, so nothing below is known: ${u}`),
    ...newFindings.map(
      (f) =>
        `${f.workflowName} / ${f.namespace} is a code node rejecting leads with the lead validation reasons ` +
        `(${f.reasons.map((r) => `"${r}"`).join(', ')}). These rejections belong in a Lead Validation step, where ` +
        'each check and its reason is set on the canvas and reported per reason; a script here brings back the ' +
        `hand written copy the swap retired. Workflow ${f.workflowId}.`,
    ),
    ...staleExceptions.map(
      (e) =>
        `${e.label} / ${e.namespace} is listed as a known validation script until ${e.endedBy}, but no active ` +
        `workflow has it any more. If ${e.endedBy} has swapped it to a Lead Validation step, remove the entry from ` +
        'KNOWN_VALIDATION_SCRIPTS in validation-script-guard.ts; if the workflow was switched off or the step ' +
        'renamed, correct the entry instead.',
    ),
  ]

  const notify =
    deps.notify ??
    ((m: string[], remedy: AlertRemedy) =>
      notifyExportFailure(supabase, VALIDATION_SCRIPT_GUARD_JOB, m, env.IDEMPOTENCY as never, remedy))
  await notify(messages, VALIDATION_SCRIPT_REMEDY)

  // Every count is logged, the excepted ones included: going quiet in Slack must
  // not also make them invisible here.
  console.log(
    `[validation-script-guard] scanned=${String(scanned)} flagged=${String(findings.length)} ` +
      `new=${String(newFindings.length)} stale_exceptions=${String(staleExceptions.length)} ` +
      `unreadable=${String(unreadable.length)}`,
  )

  return { findings, newFindings, staleExceptions, unreadable, scanned, alerted: messages.length > 0 }
}

/** The run record's ending: a run that read nothing is unmeasured, never ok (L557). */
export function endingOf(r: ValidationScriptCheckResult): JobRunEnding {
  const outcome =
    r.unreadable.length > 0 ? 'unmeasured' : r.newFindings.length > 0 || r.staleExceptions.length > 0 ? 'findings' : 'ok'
  return {
    outcome,
    summary: {
      scanned: r.scanned,
      flagged: r.findings.map((f) => `${f.workflowId}/${f.namespace}`),
      new: r.newFindings.map((f) => `${f.workflowId}/${f.namespace}`),
      stale_exceptions: r.staleExceptions.map((e) => `${e.workflowId}/${e.namespace}`),
      unreadable: r.unreadable,
    },
  }
}

/** What the scheduled handler calls: the check under a job run record. */
export function runValidationScriptGuardForEnv(supabase: SupabaseClient, env: Env): Promise<ValidationScriptCheckResult> {
  return withJobRun(supabase, VALIDATION_SCRIPT_GUARD_JOB, () => checkValidationScripts(env, supabase), endingOf)
}
