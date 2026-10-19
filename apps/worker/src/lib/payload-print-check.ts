import type { SupabaseClient } from '@supabase/supabase-js'
import { findPayloadPrints, type PayloadPrint } from './payload-print-scan'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { formatErr } from './format-error'
import { fetchAllPaged } from './paginate'
import { isAccepted } from './payload-print-baseline'

export const PAYLOAD_PRINT_JOB = 'code-node-payload-prints'

/**
 * What the alert says, in the vocabulary of the place the reader will act
 * (L399). Without this the shared alerter classifies the message text, fails to
 * recognise it, and falls back to its export wording: on 2026-09-10 the first
 * real finding this check produced was delivered under "the affected rows were
 * not exported ... check Snowflake availability and the export credentials",
 * about a line of code in a workflow. Nothing here is exported, nothing is
 * missing from Snowflake, no credential is involved, and nothing failed.
 *
 * The remedy parameter exists precisely for a borrowing check (#1166); this one
 * shipped without using it. True for BOTH events this check can send, a finding
 * and an unreadable scan, because each line below it names which it is.
 */
export const PAYLOAD_PRINT_REMEDY: AlertRemedy = {
  consequence:
    'A code node was found writing a value into the log stream, or the scan could not run. ' +
    'This is about a line of code in a workflow, not about data in transit: nothing failed and ' +
    'nothing is missing. The lines below say which case this is:',
  fixHint:
    'For a reported node: open that workflow on the canvas, find the named step, and either stop ' +
    'logging the value or log only the specific fields you need. If the line is deliberate and the ' +
    'value is safe, add it to ACCEPTED_PRINT_SITES in payload-print-baseline.ts so it stops being ' +
    'reported. For a scan that could not run: the check itself needs attention, not any workflow.',
  /**
   * A scan that RAN and found a line of code has not failed, and the line it
   * found is not an error (#1210). On 2026-09-10 this check's first real
   * finding arrived headlined 'code-node-payload-prints failed' directly above
   * its own sentence saying nothing failed and nothing is missing.
   *
   * 'has findings' rather than something more specific because this alert
   * carries two cases, a node that was found and a scan that could not run, and
   * a verb naming either one is false about the other. What is true of both is
   * that there are items listed below it.
   */
  headlineVerb: 'has findings',
  itemNoun: { one: 'finding', many: 'findings' },
}

export interface PayloadPrintFinding extends PayloadPrint {
  workflowId: string
  workflowName: string
}

export interface PayloadPrintCheckResult {
  /** Every site found, accepted or not, so an accepted one is never lost. */
  findings: PayloadPrintFinding[]
  /** The ones not in the accepted baseline. Only these alert. */
  newFindings: PayloadPrintFinding[]
  /** Non-empty when the definitions could not be read. Its own condition (L98). */
  unreadable: string[]
  alerted: boolean
}

export interface PayloadPrintCheckDeps {
  readWorkflows?: () => Promise<Array<{ id: string; name: string; definition: unknown }>>
  /** Injected so a test asserts WHAT would be sent, not just that nothing threw. */
  notify?: (messages: string[], remedy?: AlertRemedy) => Promise<void>
}

/** Every undeleted workflow's definition, active or not, of every organization. Throws on a failed read. */
export async function readLiveWorkflowDefinitions(supabase: SupabaseClient): Promise<Array<{ id: string; name: string; definition: unknown }>> {
  // Paged by the primary key past PostgREST's 1,000 row cap (#1437).
  return fetchAllPaged<{ id: string; name: string; definition: unknown }>(
    (from, to) =>
      supabase
        .from('workflows')
        .select('id, name, definition')
        // Soft delete: tombstones are not live workflows and must not be scanned.
        .is('deleted_at', null)
        .order('id', { ascending: true })
        .range(from, to),
    'workflow definitions read',
  )
}

/**
 * Daily scan for code nodes printing a whole object into the log stream (#1230).
 *
 * Reads the DEFINITIONS TABLE rather than a committed copy, because the
 * definitions live in the database and are edited on the canvas, so a scan over
 * the repository would see nothing. It runs over every live workflow rather than
 * only newly saved ones, because a save-time check would leave every definition
 * that existed when it shipped permanently unchecked, which is the population
 * that matters (L389).
 *
 * What it costs if it is wrong: a false finding sits in front of whoever reads
 * the alert every single day, which is what teaches people to skip the whole
 * alert. That is why the detector's not-flagged cases carry as many tests as its
 * flagged ones, and why it was calibrated against all eleven live definitions
 * before shipping.
 */
export async function checkPayloadPrints(
  env: { IDEMPOTENCY?: unknown },
  supabase: SupabaseClient,
  deps: PayloadPrintCheckDeps = {},
): Promise<PayloadPrintCheckResult> {
  const unreadable: string[] = []
  const findings: PayloadPrintFinding[] = []

  const readWorkflows = deps.readWorkflows ?? (() => readLiveWorkflowDefinitions(supabase))

  try {
    const rows = await readWorkflows()
    if (rows.length === 0) {
      // Zero workflows is not a clean bill of health, it is a read that found
      // nothing, and this account always has some (L98).
      unreadable.push('no workflows were returned, so nothing was actually scanned')
    }
    for (const row of rows) {
      for (const hit of findPayloadPrints(row.definition)) {
        findings.push({ ...hit, workflowId: row.id, workflowName: row.name })
      }
    }
  } catch (err) {
    unreadable.push(
      `the workflow definitions could not be read: ${formatErr(err)}`,
    )
  }

  const newFindings = findings.filter(
    (f) => !isAccepted({ workflow: f.workflowName, namespace: f.namespace, identifier: f.identifier }),
  )

  const messages = [
    ...unreadable.map((u) => `Code node log scan could not run, so nothing below is known: ${u}`),
    ...newFindings.map(
      (f) =>
        `${f.workflowName} / ${f.namespace} prints the whole of \`${f.identifier}\` to the log. ` +
        // No Logpush job exports console output since 2026-09-09 (logpush-expectation.ts), so the
        // value stays in Workers Logs, which is still readable by anyone with log access (#835).
        'Console output is captured by the platform before any redaction of ours runs, so the whole ' +
        'value is kept in Workers Logs, where anyone with log access to this worker can read it.',
    ),
  ]

  const notify =
    deps.notify ??
    ((m: string[], remedy: AlertRemedy = PAYLOAD_PRINT_REMEDY) =>
      notifyExportFailure(supabase, PAYLOAD_PRINT_JOB, m, env.IDEMPOTENCY as never, remedy))
  await notify(messages, PAYLOAD_PRINT_REMEDY)

  // Both counts are logged: the accepted ones going quiet in Slack must not also
  // go quiet here, or the debt becomes invisible rather than deferred.
  console.log(
    `[payload-print-check] findings=${String(findings.length)} ` +
      `new=${String(newFindings.length)} unreadable=${String(unreadable.length)}`,
  )

  return { findings, newFindings, unreadable, alerted: messages.length > 0 }
}
