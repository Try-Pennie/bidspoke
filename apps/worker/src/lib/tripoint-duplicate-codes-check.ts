/**
 * Comparing the live Tripoint duplicate rule with the code list, daily (#1647).
 *
 * Since #1549 the Tripoint result codes that mean Duplicate are ONE list in code,
 * TRIPOINT_DUPLICATE_SIGNALS in engine/bid-resolver.ts, which the sightings, the
 * Snowflake export and the Salesforce patch scripts are all held to by a test.
 * The buyer_select node is the exception: it reads the same rule from the Tripoint
 * partner record, partner_configs.duplicate_signals, which anyone can edit on the
 * partner page. A hand edit there splits how the node classes a sale from how
 * everything else classes it, and nothing else would say so. A setting a person
 * edits by hand is asserted on a schedule rather than audited at change time (L502).
 *
 * WHAT IT COMPARES IS BEHAVIOUR, NOT TEXT. Every result code from 990 to 1100,
 * plus any code either rule names outside that range, is put through
 * responseClassOf, the function the node itself calls, once with the live rule
 * and once with the code list, as a number and as a string (Tripoint's answers
 * are typed from JSON and the rule's values are author entered). A reordered or
 * reformatted rule that classes every code the same way is agreement; a field
 * path typo, which reads as a harmless edit, is every duplicate turning into Fail.
 *
 * FOUR OUTCOMES, EACH ITS OWN MESSAGE (L11): agree, disagree (naming each code and
 * what each side says), the record could not be read, and there is no Tripoint
 * partner. A failed read is never "no differences" (L98).
 *
 * Run from the same 13:00 UTC batch as the Tripoint pricing check, under its own
 * failure boundary and its own alert state, because its remedy is a different
 * setting and a shared alert would make each finding clear the other's (L53).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { responseClassOf, type ResponseClass, type Signal } from '@bidspoke/buyer-profile'
import { formatErr } from './format-error'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { withJobRun, type JobRunEnding } from './job-run-record'
import { duplicateSignalsOf } from './buyer-profile-loader'
import { TRIPOINT_DUPLICATE_SIGNALS } from '../engine/bid-resolver'
import type { Env } from '../index'

export const TRIPOINT_DUPLICATE_CODES_JOB = 'tripoint-duplicate-codes'

/** Every documented Tripoint code and well past them on both sides, as the #1549 test scans. */
const SCANNED_CODES: readonly number[] = Array.from({ length: 1101 - 990 }, (_, i) => 990 + i)

export const TRIPOINT_DUPLICATE_CODES_REMEDY: AlertRemedy = {
  consequence:
    "The Tripoint partner record's duplicate rule, which the buyer_select node uses to class a declined sale as " +
    "Duplicate or Fail, was compared with the list Bidspoke's code uses everywhere else, and either disagrees or " +
    'could not be compared. This is about a setting, not data: nothing was sent anywhere and nothing is missing. ' +
    'While they disagree, Salesforce is told a different class for the listed codes depending on which path sold ' +
    'the lead. The lines below say which case this is:',
  fixHint:
    'Codes that disagree: open Partners, Tripoint, and set the duplicate codes back to 1002, 1003, 1004, 1005 and ' +
    '1020 on data.createLead.resultCode, or, if Tripoint really changed its codes, change TRIPOINT_DUPLICATE_RESULT_CODES ' +
    'in the worker and the partner record together. A record that could not be read or is missing: the check itself ' +
    'needs attention (the database connection, or the Tripoint partner row). It runs again at 13:00 UTC.',
  headlineVerb: 'has findings',
  itemNoun: { one: 'finding', many: 'findings' },
}

export interface CodeDisagreement {
  code: number
  /** What the partner record's rule classes a decline with this code as. */
  live: ResponseClass | null
  /** What the code list classes it as. */
  reference: ResponseClass | null
}

export type DuplicateCodesOutcome = 'agree' | 'disagree' | 'unreadable' | 'missing' | 'failed'

export interface DuplicateCodesCheckResult {
  outcome: DuplicateCodesOutcome
  disagreements: CodeDisagreement[]
  /** The alert lines. Empty exactly when the outcome is agree. */
  findings: string[]
  alerted: boolean
}

/** A declined Tripoint answer carrying one result code, in the captured answers' shape. */
const answerFor = (resultCode: number | string) => ({ ok: true, data: { createLead: { resultCode } } })

/** Every whole number a rule's values name, so a code listed outside the scanned range is still compared. */
function codesNamedBy(rules: readonly Signal[]): number[] {
  const values = rules.flatMap((r) => [...(Array.isArray(r.in) ? r.in : []), ...(Array.isArray(r.not_in) ? r.not_in : []), r.equals])
  return values
    .map((v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v))
    .filter((v): v is number => typeof v === 'number' && Number.isInteger(v))
}

/**
 * The codes the two rules class differently on a decline. An accepted sale is
 * Success whatever the rules say, so only the decline path can disagree.
 */
export function duplicateCodeDisagreements(live: readonly Signal[], reference: readonly Signal[]): CodeDisagreement[] {
  const codes = [...new Set([...SCANNED_CODES, ...codesNamedBy(live), ...codesNamedBy(reference)])].sort((a, b) => a - b)
  const out: CodeDisagreement[] = []
  for (const code of codes) {
    for (const sent of [code, String(code)]) {
      const l = responseClassOf('declined_by_buyer', live, answerFor(sent))
      const r = responseClassOf('declined_by_buyer', reference, answerFor(sent))
      if (l !== r) {
        out.push({ code, live: l, reference: r })
        break
      }
    }
  }
  return out
}

async function compare(supabase: SupabaseClient): Promise<Omit<DuplicateCodesCheckResult, 'alerted'>> {
  const { data, error } = await supabase
    .from('partner_configs')
    .select('duplicate_signals')
    .eq('slug', 'tripoint')
    .maybeSingle()

  if (error) {
    return {
      outcome: 'unreadable',
      disagreements: [],
      findings: [`the Tripoint partner record could not be read, so its duplicate codes were NOT compared: ${formatErr(error)}`],
    }
  }
  if (!data) {
    return {
      outcome: 'missing',
      disagreements: [],
      findings: ['no partner_configs row has slug tripoint, so there is no duplicate rule to compare with the code list'],
    }
  }

  const raw = (data as { duplicate_signals?: unknown }).duplicate_signals
  const disagreements = duplicateCodeDisagreements(duplicateSignalsOf(raw), TRIPOINT_DUPLICATE_SIGNALS)
  if (disagreements.length === 0) return { outcome: 'agree', disagreements, findings: [] }

  const findings: string[] = []
  if (!Array.isArray(raw)) {
    findings.push(
      `the Tripoint partner record's duplicate_signals is not a list, so buyer_select reads it as no duplicate rules and classes every decline as Fail. It holds: ${JSON.stringify(raw ?? null).slice(0, 300)}`,
    )
  }
  for (const d of disagreements) {
    findings.push(`result code ${d.code}: the partner record says ${d.live ?? 'no class'}, the code list says ${d.reference ?? 'no class'}`)
  }
  return { outcome: 'disagree', disagreements, findings }
}

/**
 * NEVER THROWS. Its caller is a `waitUntil`, where a rejection reaches only a
 * console nobody is watching (L71). The run is recorded in job_runs whichever
 * way it ends, so a day with no alert can be told from a day it did not run.
 */
export async function checkTripointDuplicateCodes(env: Env, supabase: SupabaseClient): Promise<DuplicateCodesCheckResult> {
  return withJobRun(supabase, TRIPOINT_DUPLICATE_CODES_JOB, () => run(env, supabase), duplicateCodesEnding)
}

async function run(env: Env, supabase: SupabaseClient): Promise<DuplicateCodesCheckResult> {
  let result: Omit<DuplicateCodesCheckResult, 'alerted'>
  try {
    result = await compare(supabase)
  } catch (err) {
    result = {
      outcome: 'failed',
      disagreements: [],
      findings: [`the Tripoint duplicate codes check itself failed: ${formatErr(err)}`],
    }
  }
  // AN EMPTY LIST IS STILL SENT: the alerter reads no findings as the recovery
  // signal and clears a standing alert with it.
  try {
    await notifyExportFailure(supabase, TRIPOINT_DUPLICATE_CODES_JOB, result.findings, env.IDEMPOTENCY, TRIPOINT_DUPLICATE_CODES_REMEDY)
  } catch (err) {
    console.error('[tripoint-duplicate-codes] could not send its alert:', formatErr(err))
  }
  // Logged on every run, a clean one included, so a working check is visible.
  console.log(`[tripoint-duplicate-codes] ${result.outcome} codes=${result.disagreements.map((d) => d.code).join(',') || 'none'}`)
  return { ...result, alerted: result.findings.length > 0 }
}

export function duplicateCodesEnding(result: DuplicateCodesCheckResult): JobRunEnding {
  return {
    outcome: result.outcome,
    detail: result.findings.join('; ') || 'the partner record and the code list class every code the same way',
    summary: { disagreeing_codes: result.disagreements.map((d) => d.code) },
  }
}
