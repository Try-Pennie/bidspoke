/**
 * The daily read-back of Main Flow's native invalid state writes (#2173, the
 * phase 4 canary of #1680).
 *
 * WHY. Since version 172 (2026-10-16 23:20 UTC) Main Flow's
 * `invalid_state_sf_post` writes its Submission straight to Salesforce instead
 * of through the Pipedream relay, while the other eight outcome posts stay on
 * the relay. #2173's acceptance is read back from Salesforce over at least a
 * week with the run count stated, and Dan wanted that watched with no Claude
 * session open, so it lives here, in the 9 AM ET daily batch (`0 13 * * *`, the
 * slot every daily report shares; 8 AM ET once clocks go back).
 *
 * WHAT IT READS. Every Main Flow step named `invalid_state_sf_post` in the 24
 * hours ending ten minutes before the run (canaryWatchWindow), so consecutive
 * days tile and a run still writing its steps at 9 AM is read the next day.
 * "Ran natively" means the step ran as a Salesforce step, which only version 172
 * and later do; a relay post of that step is counted apart, because it means
 * Main Flow was rolled back. Test runs are left out.
 *
 * WHAT "LANDED" MEANS, PER RUN, read back through the #2023 read-back's own
 * Salesforce path (salesforcePortFor, one GET, raced against its deadline):
 *  - the Submission holds this run's write stamp (any attempt: a read-back
 *    resend carries 1 or 2), when the run sent one;
 *  - its PDFlow_4__c holds this run's Bidspoke link, built here from the run id
 *    rather than read from what the run recorded, so a wrong link in both cannot
 *    agree with itself (L58);
 *  - every other key the body sent, after the port's rename and omit, holds the
 *    value sent, compared the way the read-back compares (sameSalesforceValue);
 *  - its Lead's EngineUUID__c and EngineLeadUUID__c equal the Submission's
 *    Engine_UUID_SO__c and Engine_Lead_UUID_SO__c, the copy SubmissionService
 *    makes on update (read from the org's Apex on 2026-10-16).
 * A read that gets no answer, a refused login or an answer it cannot parse is
 * "could not check", never landed, and the first unanswered read stops the
 * Salesforce reads for the day, as the read-back's circuit does. A write the
 * run skipped (`skip_when_empty`) is counted and said, and read for nothing.
 *
 * NOT CHECKED HERE, from #2173's acceptance: that fields the body did not send
 * are unchanged (that needs a snapshot taken before the write, which only the
 * run could take), and Regal's Lead fields. Those are read by hand.
 *
 * THE RELAY COMPARISON is the eight other outcome posts' steps in the same
 * window that ran as relay posts: how many Pipedream answered with a 2xx. That
 * is all Bidspoke can see of the relay, so the message says so, and gives the
 * direct writes' figure on the same measure (steps that completed) beside the
 * Salesforce read-back.
 *
 * ONE MESSAGE A DAY to Main Flow's organization's alerts channel. A day with any
 * run that did not land, or could not be checked, or a check that could not run,
 * is titled as an alert with a Fix line; otherwise it is a report. It arms no
 * all-clear marker, because the next day's message is the stand down, so it has
 * no INCIDENT_SIGNALS entry.
 *
 * REMOVING IT. It ends with the canary: the phase 6 pull request (#2175, which
 * moves the other seven posts and so leaves no relay to compare against) deletes
 * this file, its test, its CRON_JOBS entry and its block in index.ts. The steps
 * are in docs/main-flow-relay-port.md. Until then, a day on which no other post
 * went through the relay says so.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import { bidspokeRunLink } from '../engine/context'
import type { SalesforceRead } from '../engine/inquiry-post'
import { parseWriteMarker, WRITE_MARKER_FIELD } from '../engine/write-marker'
import { MAIN_FLOW_WORKFLOW_ID, OUTCOME_POSTS } from './main-flow-port/transform'
import { isSalesforceApiName, isSalesforceRecordId, salesforcePortFor } from './writeback-replay'
import { sameSalesforceValue } from './salesforce-field-conflict'
import { raceDeadline } from './alert-claim'
import { secretKeys } from './secret-crypto'
import { formatErr } from './format-error'
import { recordFinishedJobRun, type JobRunEnding } from './job-run-record'
import { etTime, getSlackConnection, postMessage } from './slack'

export const INVALID_STATE_WATCH_JOB = 'invalid-state-canary-watch'

/** The post this watch reads back. */
export const WATCHED_STEP = 'invalid_state_sf_post'

/** The eight posts still on the relay, the comparison. */
export const RELAY_COMPARISON_POSTS: readonly string[] = OUTCOME_POSTS.filter((p) => p !== WATCHED_STEP)

/** The window ends this long before the run, so a run still recording its steps is read the next day. */
export const WINDOW_END_LAG_MS = 10 * 60_000

const DAY_MS = 24 * 60 * 60_000

/** How long one Salesforce read may take, the read-back's own bound (SF_CALL_DEADLINE_MS). */
export const SF_READ_DEADLINE_MS = 12_000

/** Runs named one by one in the message; the rest are counted. */
export const MAX_LISTED_RUNS = 15

/** The step rows read per day, at most. About 19 a day ran in the week before the canary. */
export const MAX_STEPS = 1000

const RUN_LINK_FIELD = 'PDFlow_4__c'
const SUB_UUID = 'Engine_UUID_SO__c'
const SUB_LEAD_UUID = 'Engine_Lead_UUID_SO__c'
const LEAD_UUID = 'EngineUUID__c'
const LEAD_LEAD_UUID = 'EngineLeadUUID__c'
/** A value the step logger's PII scrub replaced: what was sent cannot be known from it. */
const REDACTED = '[REDACTED]'

export interface WatchedStep {
  execution_id: string
  step_type: string
  status: string
  input: unknown
  output: unknown
}

export interface RelayCounts {
  /** Relay posts of the eight other outcome steps in the window. */
  total: number
  /** Of those, the ones Pipedream answered with a 2xx. */
  accepted: number
}

export type RunVerdict =
  | { kind: 'landed'; executionId: string }
  | { kind: 'not_landed'; executionId: string; problems: string[] }
  | { kind: 'unchecked'; executionId: string; reason: string }

export interface CanaryWatchReport {
  from: string
  to: string
  /** The runs whose step ran natively and sent a write, in the order read. */
  native: RunVerdict[]
  /** Native steps that skipped the write, with the reason the step recorded. */
  skipped: Array<{ executionId: string; reason: string }>
  /** Steps of the watched post that went through the relay instead. */
  relayInvalidState: number
  /** Of the native runs that sent a write, how many the step itself recorded as completed. */
  nativeCompleted: number
  relay: RelayCounts | { error: string }
  /** The step read failed, so nothing was checked. */
  readError?: string
}

export interface CanaryWatchMessage {
  title: string
  lines: string[]
  fixHint?: string
  /** A run did not land, could not be checked, or the check could not run. */
  alert: boolean
}

export interface CanaryWatchDeps {
  now: () => number
  appUrl: string
  /** Every step of the watched post in [from, to), test runs left out. Throws on a failed read. */
  readSteps: (fromIso: string, toIso: string) => Promise<WatchedStep[]>
  /** The relay comparison over [from, to). Throws on a failed read. */
  countRelay: (fromIso: string, toIso: string) => Promise<RelayCounts>
  /** Main Flow's Salesforce, as one read: `path` below `/services/data/v60.0`. Throws when its settings cannot be loaded. */
  salesforce: () => Promise<(path: string) => Promise<SalesforceRead>>
  /** Posts the message. True when Slack took it. */
  post: (message: CanaryWatchMessage) => Promise<boolean>
  recordRun?: (startedAtMs: number, ending: JobRunEnding) => Promise<void>
}

/** The 24 hours the run at `nowMs` reads. */
export function canaryWatchWindow(nowMs: number): { from: string; to: string } {
  const to = nowMs - WINDOW_END_LAG_MS
  return { from: new Date(to - DAY_MS).toISOString(), to: new Date(to).toISOString() }
}

const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

function errorCodeOf(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text)
    const first = Array.isArray(parsed) ? asObject(parsed[0]) : null
    return first && typeof first.errorCode === 'string' ? first.errorCode : null
  } catch {
    return null
  }
}

const joinAnd = (items: string[]): string =>
  items.length <= 1 ? items.join('') : items.length === 2 ? `${items[0]} and ${items[1]}` : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

type Read = (path: string) => Promise<SalesforceRead>

/** One record read: the object, or why it could not be had. */
type RecordRead =
  | { kind: 'record'; body: Record<string, unknown> }
  | { kind: 'missing' }
  | { kind: 'unread'; reason: string; stop: boolean }

async function readRecord(read: Read, what: string, path: string): Promise<RecordRead> {
  const r = await read(path)
  if (r.kind === 'no_answer') return { kind: 'unread', reason: `Salesforce did not answer the ${what} read (${r.error}).`, stop: true }
  if (r.status === 404) return { kind: 'missing' }
  const code = errorCodeOf(r.text)
  const said = `${r.status}${code ? ` ${code}` : ''}`
  if (r.status === 401 || r.status === 403) return { kind: 'unread', reason: `Salesforce refused the login (${said}).`, stop: true }
  if (r.status < 200 || r.status >= 300) return { kind: 'unread', reason: `Salesforce answered the ${what} read with ${said}.`, stop: false }
  try {
    const body = asObject(JSON.parse(r.text))
    if (body) return { kind: 'record', body }
  } catch {
    // Not JSON: below.
  }
  return { kind: 'unread', reason: `Salesforce's answer to the ${what} read could not be read.`, stop: false }
}

/** One native run's read-back. `stop` says Salesforce stopped answering. */
async function checkRun(step: WatchedStep, read: Read, appUrl: string): Promise<{ verdict: RunVerdict; stop: boolean }> {
  const executionId = step.execution_id
  const unchecked = (reason: string, stop = false) => ({ verdict: { kind: 'unchecked' as const, executionId, reason }, stop })
  const resolved = asObject(asObject(step.input)?.resolved)
  const sent = asObject(resolved?.body)
  const recordId = resolved?.record_id
  if (!sent || typeof recordId !== 'string' || !isSalesforceRecordId(recordId)) {
    return unchecked('The run did not record the Submission it wrote or what it sent.')
  }
  const expectedLink = bidspokeRunLink(appUrl, MAIN_FLOW_WORKFLOW_ID, executionId)
  if (!expectedLink) return unchecked('The app address is not set, so the run link cannot be compared.')
  const sentFields = Object.keys(sent).filter((k) => k !== WRITE_MARKER_FIELD && k !== RUN_LINK_FIELD)
  if (!sentFields.every(isSalesforceApiName)) return unchecked('The run sent a key that is not a Salesforce field name, so it was not read back.')

  const fields = [...new Set([WRITE_MARKER_FIELD, RUN_LINK_FIELD, 'Lead__c', SUB_UUID, SUB_LEAD_UUID, ...sentFields])]
  const sub = await readRecord(read, 'Submission', `/sobjects/Submission__c/${recordId}?fields=${fields.join(',')}`)
  if (sub.kind === 'unread') return unchecked(sub.reason, sub.stop)
  if (sub.kind === 'missing') return { verdict: { kind: 'not_landed', executionId, problems: ['The Submission does not exist in Salesforce.'] }, stop: false }
  const current = sub.body

  const problems: string[] = []
  if (typeof sent[WRITE_MARKER_FIELD] === 'string') {
    const stamp = parseWriteMarker(current[WRITE_MARKER_FIELD])
    if (!stamp) problems.push("The Submission does not carry this run's write stamp.")
    else if (stamp.executionId !== executionId || stamp.stepNamespace !== WATCHED_STEP) {
      problems.push(`Another write has stamped the Submission since (run ${stamp.executionId}), so a difference below may be that write's.`)
    }
  }
  const link = current[RUN_LINK_FIELD]
  if (link === null || link === undefined || link === '') problems.push('The Submission has no Bidspoke run link.')
  else if (link !== expectedLink) problems.push("The Submission's Bidspoke run link is not this run's.")
  const differing = sentFields.filter((k) => sent[k] !== REDACTED && (!(k in current) || !sameSalesforceValue(current[k], sent[k]))).sort()
  if (differing.length > 0) {
    const n = differing.length
    problems.push(`${n} field${n === 1 ? ' holds' : 's hold'} a different value from the one the run sent: ${joinAnd(differing)}.`)
  }

  const leadId = current.Lead__c
  if (typeof leadId !== 'string' || !isSalesforceRecordId(leadId)) {
    problems.push('The Submission has no Lead, so its Engine ids reached no Lead.')
  } else {
    const lead = await readRecord(read, 'Lead', `/sobjects/Lead/${leadId}?fields=${LEAD_UUID},${LEAD_LEAD_UUID}`)
    if (lead.kind === 'unread') {
      if (problems.length === 0) return unchecked(lead.reason, lead.stop)
      problems.push(`Its Lead could not be read: ${lead.reason}`)
      return { verdict: { kind: 'not_landed', executionId, problems }, stop: lead.stop }
    }
    if (lead.kind === 'missing') problems.push("The Submission's Lead does not exist in Salesforce.")
    else {
      const which: string[] = []
      if (!sameSalesforceValue(lead.body[LEAD_UUID], current[SUB_UUID])) which.push('Engine UUID')
      if (!sameSalesforceValue(lead.body[LEAD_LEAD_UUID], current[SUB_LEAD_UUID])) which.push('Engine Lead UUID')
      if (which.length > 0) problems.push(`The Lead's ${joinAnd(which)} differ${which.length === 1 ? 's' : ''} from the Submission's.`)
    }
  }
  return { verdict: problems.length === 0 ? { kind: 'landed', executionId } : { kind: 'not_landed', executionId, problems }, stop: false }
}

/** Reads the window and every native run in it back from Salesforce. Never throws. */
async function measure(deps: CanaryWatchDeps, from: string, to: string): Promise<CanaryWatchReport> {
  const report: CanaryWatchReport = { from, to, native: [], skipped: [], relayInvalidState: 0, nativeCompleted: 0, relay: { total: 0, accepted: 0 } }
  const relayPromise = deps.countRelay(from, to).then(
    (r): RelayCounts | { error: string } => r,
    (e: unknown) => ({ error: formatErr(e) }),
  )
  let steps: WatchedStep[]
  try {
    steps = await deps.readSteps(from, to)
  } catch (e) {
    report.readError = formatErr(e)
    report.relay = await relayPromise
    return report
  }
  const toRead: WatchedStep[] = []
  for (const s of steps) {
    if (s.step_type !== 'salesforce') {
      report.relayInvalidState++
      continue
    }
    const out = asObject(s.output)
    if (out?.skipped === true) {
      report.skipped.push({ executionId: s.execution_id, reason: typeof out.skip_reason === 'string' ? out.skip_reason : 'unknown' })
      continue
    }
    if (s.status === 'completed') report.nativeCompleted++
    toRead.push(s)
  }

  let read: Read | null = null
  let stopReason: string | null = null
  if (toRead.length > 0) {
    try {
      read = await deps.salesforce()
    } catch (e) {
      stopReason = `Salesforce settings could not be loaded (${formatErr(e)}).`
    }
  }
  for (const s of toRead) {
    if (!read || stopReason) {
      report.native.push({ kind: 'unchecked', executionId: s.execution_id, reason: stopReason ?? 'Salesforce stopped answering earlier in this check.' })
      continue
    }
    try {
      const { verdict, stop } = await checkRun(s, read, deps.appUrl)
      report.native.push(verdict)
      if (stop) stopReason = 'Salesforce stopped answering earlier in this check.'
    } catch (e) {
      report.native.push({ kind: 'unchecked', executionId: s.execution_id, reason: `The check failed on this run (${formatErr(e)}).` })
    }
  }
  report.relay = await relayPromise
  return report
}

const fmt = (n: number) => n.toLocaleString('en-US')
const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(1)}%`
const runLabel = (appUrl: string, id: string) => {
  const url = bidspokeRunLink(appUrl, MAIN_FLOW_WORKFLOW_ID, id)
  return url ? `<${url}|Run ${id}>` : `Run ${id}`
}

const SKIP_WORDS: Record<string, string> = {
  nothing_to_write: 'the Engine sent nothing to write',
  no_record_id: 'there was no Submission to write to',
}

/** The day's message, separate from the send so the words can be tested. */
export function canaryWatchMessage(report: CanaryWatchReport, appUrl: string): CanaryWatchMessage {
  const span = `from ${etTime(report.from)} to ${etTime(report.to)}`
  if (report.readError) {
    return {
      title: 'Invalid state write check could not run',
      lines: [`The check could not read yesterday's Main Flow runs from the database (${report.readError}).`],
      fixHint: 'Check the database is answering. The check runs again tomorrow at 9 AM ET.',
      alert: true,
    }
  }
  const n = report.native.length
  const landed = report.native.filter((v) => v.kind === 'landed').length
  const notLanded = report.native.filter((v) => v.kind === 'not_landed').length
  const unchecked = report.native.filter((v) => v.kind === 'unchecked').length
  const lines: string[] = []

  if (n === 0) {
    lines.push(`Zero Main Flow runs wrote an invalid state outcome straight to Salesforce ${span}.`)
  } else {
    lines.push(
      `${fmt(n)} Main Flow run${n === 1 ? '' : 's'} wrote an invalid state outcome straight to Salesforce ${span}. ` +
        `${fmt(landed)} landed fully: the Submission holds the run's link and every field it sent, and its Lead carries the same Engine ids.`,
    )
  }
  if (report.skipped.length > 0) {
    const k = report.skipped.length
    const reasons = joinAnd([...new Set(report.skipped.map((s) => SKIP_WORDS[s.reason] ?? `the step said ${s.reason}`))])
    lines.push(`${fmt(k)} more run${k === 1 ? ' was' : 's were'} skipped because ${reasons}, so nothing was sent.`)
  }
  if (report.relayInvalidState > 0) {
    const r = report.relayInvalidState
    lines.push(`${fmt(r)} invalid state post${r === 1 ? '' : 's'} went through the relay instead, so Main Flow is no longer on the direct write.`)
  }

  const bad = report.native.filter((v) => v.kind !== 'landed')
  for (const v of bad.slice(0, MAX_LISTED_RUNS)) {
    lines.push(v.kind === 'not_landed' ? `${runLabel(appUrl, v.executionId)}: ${v.problems.join(' ')}` : `${runLabel(appUrl, v.executionId)} could not be checked: ${v.kind === 'unchecked' ? v.reason : ''}`)
  }
  if (bad.length > MAX_LISTED_RUNS) {
    lines.push(`${fmt(bad.length - MAX_LISTED_RUNS)} more runs did not land fully or could not be checked; the job run record lists them all.`)
  }

  if ('error' in report.relay) {
    lines.push(`The relay's numbers could not be read from the database (${report.relay.error}).`)
  } else if (report.relay.total === 0) {
    lines.push('No other outcome post went through the relay in those hours, so there is nothing to compare against.')
  } else {
    const r = report.relay
    let relayLine =
      `Over the same hours the relay took ${fmt(r.accepted)} of Main Flow's ${fmt(r.total)} other outcome posts (${pct(r.accepted, r.total)}). ` +
      'That counts posts Pipedream answered with a success, not what reached Salesforce.'
    if (n > 0) relayLine += ` Bidspoke's own record of the direct writes, the same measure, is ${fmt(report.nativeCompleted)} of ${fmt(n)} completed (${pct(report.nativeCompleted, n)}).`
    lines.push(relayLine)
  }

  const alert = bad.length > 0
  let title: string
  if (notLanded > 0 && unchecked > 0) title = `${fmt(notLanded)} of ${fmt(n)} invalid state writes did not land in Salesforce, and ${fmt(unchecked)} could not be checked`
  else if (notLanded > 0) title = `${fmt(notLanded)} of ${fmt(n)} invalid state writes did not land in Salesforce`
  else if (unchecked > 0) title = `${fmt(unchecked)} of ${fmt(n)} invalid state writes could not be checked in Salesforce`
  else if (n === 0) title = 'No invalid state writes to check yesterday'
  else title = n === 1 ? 'The invalid state write landed in Salesforce' : `All ${fmt(n)} invalid state writes landed in Salesforce`

  return {
    title,
    lines,
    ...(alert
      ? {
          fixHint:
            notLanded > 0
              ? 'Open each run above and its Submission in Salesforce. If writes are being lost, roll Main Flow back to the relay with the saved rollback record.'
              : 'Check Salesforce is answering and its login works. The check runs again tomorrow at 9 AM ET; check these runs by hand meanwhile.',
        }
      : {}),
    alert,
  }
}

/** Slack's limit on one section's text is 3,000 characters, so each line is its own section. */
const SECTION_MAX = 2_900

/** The message as Slack blocks: the title, one section per line, then the Fix line. */
export function canaryWatchBlocks(message: CanaryWatchMessage): unknown[] {
  const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text: text.length > SECTION_MAX ? `${text.slice(0, SECTION_MAX)}...` : text } })
  return [
    { type: 'header', text: { type: 'plain_text', text: message.title, emoji: false } },
    ...message.lines.map(section),
    ...(message.fixHint ? [section(`*Fix:* ${message.fixHint}`)] : []),
  ]
}

function endingOf(report: CanaryWatchReport, posted: boolean): JobRunEnding {
  const count = (k: RunVerdict['kind']) => report.native.filter((v) => v.kind === k).length
  return {
    outcome: !posted ? 'not_posted' : report.readError ? 'read_failed' : report.native.some((v) => v.kind !== 'landed') ? 'not_all_landed' : report.native.length === 0 ? 'no_runs' : 'all_landed',
    detail: report.readError ?? `${report.native.length} runs read back`,
    summary: {
      from: report.from,
      to: report.to,
      native: report.native.length,
      landed: count('landed'),
      not_landed: count('not_landed'),
      unchecked: count('unchecked'),
      skipped: report.skipped.length,
      relay_invalid_state: report.relayInvalidState,
      native_completed: report.nativeCompleted,
      relay: report.relay,
      // Run ids and what was wrong, never a value: the record behind the message's "and N more".
      runs: report.native.filter((v) => v.kind !== 'landed'),
    },
  }
}

/** The day's check, end to end. NEVER THROWS: its caller is a waitUntil, where a rejection reaches nobody (L71). */
export async function runInvalidStateWatch(deps: CanaryWatchDeps): Promise<CanaryWatchReport> {
  const startedAtMs = deps.now()
  const { from, to } = canaryWatchWindow(startedAtMs)
  const report = await measure(deps, from, to)
  let posted = false
  try {
    posted = await deps.post(canaryWatchMessage(report, deps.appUrl))
    if (!posted) console.error(`[${INVALID_STATE_WATCH_JOB}] Slack did not take the daily message`)
  } catch (e) {
    console.error(`[${INVALID_STATE_WATCH_JOB}] could not post the daily message:`, formatErr(e))
  }
  const landed = report.native.filter((v) => v.kind === 'landed').length
  console.log(
    `[${INVALID_STATE_WATCH_JOB}] from=${from} to=${to} native=${report.native.length} landed=${landed} skipped=${report.skipped.length} ` +
      `relay_invalid_state=${report.relayInvalidState} posted=${posted}${report.readError ? ` read_error=${report.readError}` : ''}`,
  )
  try {
    await deps.recordRun?.(startedAtMs, endingOf(report, posted))
  } catch (e) {
    console.error(`[${INVALID_STATE_WATCH_JOB}] could not record its run:`, formatErr(e))
  }
  return report
}

/** The production wiring: Main Flow's steps, its organization's Salesforce and Slack. Never throws. */
export async function runInvalidStateWatchForEnv(supabase: SupabaseClient, env: Env): Promise<CanaryWatchReport> {
  const keys = secretKeys(env)
  let orgPromise: Promise<string> | null = null
  const orgId = () => {
    orgPromise ??= (async () => {
      const { data, error } = await supabase.from('workflows').select('organization_id').eq('id', MAIN_FLOW_WORKFLOW_ID).maybeSingle()
      if (error) throw new Error(`Main Flow's organization could not be read: ${error.message}`)
      const id = (data as { organization_id?: unknown } | null)?.organization_id
      if (typeof id !== 'string') throw new Error('Main Flow was not found in the workflows table')
      return id
    })()
    return orgPromise
  }
  return runInvalidStateWatch({
    now: () => Date.now(),
    appUrl: env.APP_URL,
    readSteps: async (from, to) => {
      const { data, error } = await supabase
        .from('execution_steps')
        .select('execution_id, step_type, status, input, output')
        .eq('workflow_id', MAIN_FLOW_WORKFLOW_ID)
        .eq('step_namespace', WATCHED_STEP)
        .gte('execution_started_at', from)
        .lt('execution_started_at', to)
        .not('is_test', 'is', true)
        .order('execution_started_at', { ascending: true })
        .range(0, MAX_STEPS - 1)
      if (error) throw new Error(`execution_steps read failed: ${error.message}`)
      const rows = (data ?? []) as WatchedStep[]
      if (rows.length >= MAX_STEPS) throw new Error(`more than ${MAX_STEPS} invalid state steps in one day, so they were not all read`)
      return rows
    },
    countRelay: async (from, to) => {
      const base = () =>
        supabase
          .from('execution_steps')
          .select('id', { count: 'exact', head: true })
          .eq('workflow_id', MAIN_FLOW_WORKFLOW_ID)
          .in('step_namespace', [...RELAY_COMPARISON_POSTS])
          .eq('step_type', 'webhook')
          .gte('execution_started_at', from)
          .lt('execution_started_at', to)
          .not('is_test', 'is', true)
      const [all, accepted] = await Promise.all([base(), base().eq('status', 'completed').like('output->>status', '2%')])
      if (all.error) throw new Error(`relay post count failed: ${all.error.message}`)
      if (accepted.error) throw new Error(`relay accepted count failed: ${accepted.error.message}`)
      if (all.count === null || accepted.count === null) throw new Error('the relay post count came back empty')
      return { total: all.count, accepted: accepted.count }
    },
    salesforce: async () => {
      const port = await salesforcePortFor(env, supabase, keys, await orgId(), MAIN_FLOW_WORKFLOW_ID)
      return async (path: string): Promise<SalesforceRead> => {
        const raced = await raceDeadline(() => port.send('GET', path), SF_READ_DEADLINE_MS)
        if (raced.kind === 'ok') return { kind: 'answer', ...raced.value }
        return { kind: 'no_answer', error: raced.kind === 'threw' ? formatErr(raced.error) : `no answer within ${SF_READ_DEADLINE_MS / 1000} s` }
      }
    },
    post: async (message) => {
      const slack = await getSlackConnection(supabase, await orgId())
      if (!slack) throw new Error("Main Flow's organization has no Slack connection")
      return (await postMessage(slack.bot_token, slack.default_channel, canaryWatchBlocks(message), message.title)) !== null
    },
    recordRun: (startedAtMs, ending) => recordFinishedJobRun(supabase, INVALID_STATE_WATCH_JOB, startedAtMs, ending),
  })
}
