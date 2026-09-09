import type { SupabaseClient } from '@supabase/supabase-js'
import { findPayloadPrints, type PayloadPrint } from './payload-print-scan'
import { notifyExportFailure } from './export-alerts'
import { formatErr } from './format-error'
import { isAccepted } from './payload-print-baseline'

export const PAYLOAD_PRINT_JOB = 'code-node-payload-prints'

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
  notify?: (messages: string[]) => Promise<void>
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

  const readWorkflows =
    deps.readWorkflows ??
    (async () => {
      const { data, error } = await supabase
        .from('workflows')
        .select('id, name, definition')
        // Soft delete: tombstones are not live workflows and must not be scanned.
        .is('deleted_at', null)
      if (error !== null) throw new Error(JSON.stringify(error))
      return (data ?? []) as Array<{ id: string; name: string; definition: unknown }>
    })

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
        'Console output is captured by the platform before any redaction of ours runs and is ' +
        'exportable off-platform, so this leaves Bidspoke.',
    ),
  ]

  const notify =
    deps.notify ??
    ((m: string[]) => notifyExportFailure(supabase, PAYLOAD_PRINT_JOB, m, env.IDEMPOTENCY as never))
  await notify(messages)

  // Both counts are logged: the accepted ones going quiet in Slack must not also
  // go quiet here, or the debt becomes invisible rather than deferred.
  console.log(
    `[payload-print-check] findings=${String(findings.length)} ` +
      `new=${String(newFindings.length)} unreadable=${String(unreadable.length)}`,
  )

  return { findings, newFindings, unreadable, alerted: messages.length > 0 }
}
