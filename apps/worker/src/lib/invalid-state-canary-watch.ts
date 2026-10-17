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
 * and later do. A relay post of that step is counted apart, and what it means
 * depends on WHERE it falls (#2312): before the first direct post it is Main
 * Flow before the switch, and after one it is a rollback, which pages. The first
 * report read five pre switch posts as a rollback because it looked only at
 * whether any relay post was in the window. Test runs are left out.
 *
 * WHAT "LANDED" MEANS, PER RUN, read back through the #2023 read-back's own
 * Salesforce path (salesforcePortFor, one GET, raced against its deadline):
 *  - the Submission holds this run's write stamp (any attempt: a read-back
 *    resend carries 1 or 2), when the run sent one;
 *  - its PDFlow_1__c holds this run's Bidspoke link, built here from the run id
 *    rather than read from what the run recorded, so a wrong link in both cannot
 *    agree with itself (L58);
 *  - every other key the body sent, after the port's rename and omit, holds the
 *    value sent, compared the way the read-back compares (sameSalesforceValue);
 *  - when it sent the Engine ids, its Lead's EngineUUID__c and EngineLeadUUID__c
 *    equal the Submission's Engine_UUID_SO__c and Engine_Lead_UUID_SO__c, the
 *    copy SubmissionService makes on update (read from the org's Apex on
 *    2026-10-16).
 * A read that gets no answer, a refused login or an answer it cannot parse is
 * "could not check", never landed, and the first unanswered read stops the
 * Salesforce reads for the day, as the read-back's circuit does. A write the
 * run skipped (`skip_when_empty`) is counted and said, and read for nothing.
 *
 * THE FIELD NAMES were checked against the live org on 2026-10-17 (#2313,
 * Tooling FieldDefinition and a describe, read only): on Submission__c,
 * PDFlow_1__c and PDFlow_4__c are Text(255), Engine_UUID_SO__c Text(255),
 * Engine_Lead_UUID_SO__c Text(255) unique, Lead__c Lookup(Lead) and
 * Bidspoke_Write__c Text(255); on Lead, EngineUUID__c Text(100) and
 * EngineLeadUUID__c Text(100) unique. Submission__c also has its own
 * EngineUUID__c and EngineLeadUUID__c, which nothing here writes: the relay and
 * the direct post both write the _SO_ pair, and on all four direct posts read
 * that day the Lead's pair equalled the Submission's _SO_ pair while the
 * Submission's own EngineUUID__c was empty.
 *
 * WHY PDFlow_1__c IS THE RUN LINK, not PDFlow_4__c (#2313). Every outcome post's
 * body sends PDFlow_1__c as the run's Bidspoke link, on the relay and on the
 * direct write alike, and #2173 names it. PDFlow_4__c is the link the port adds
 * (decision D4), but the inquiry relay, still on Pipedream, writes the same field
 * with a Pipedream link on every run, invalid state runs included: all six
 * relay era invalid state Submissions read on 2026-10-17 held a pipedream.com
 * link there, and the four direct ones the Bidspoke link only because the direct
 * write came later. So PDFlow_4__c cannot be read on the relay side at all, and
 * on the direct side it is checked as one more key sent, where the inquiry
 * relay winning that race shows as that field differing.
 *
 * NOT CHECKED HERE, from #2173's acceptance: that fields the body did not send
 * are unchanged (that needs a snapshot taken before the write, which only the
 * run could take), and Regal's Lead fields. Those are read by hand.
 *
 * THE RELAY COMPARISON (#2313) is what Salesforce SAVED for the eight other
 * outcome posts' relay posts in the same window, read back the same way: a
 * sample of RELAY_SAMPLE_SIZE posts spread evenly over the day (the relay makes
 * about 3,400 a day, so all of them would be thousands of reads), each judged by
 * the relay's own PATCH, the body with `executionId` and `submissionId` dropped
 * and `UUID` and `leadUUID` renamed, as the port reproduces it. A relay post
 * carries no write stamp, so a Submission holding a LATER Main Flow run's link
 * was overwritten since and is left out, while one holding an earlier run's link
 * means this post never landed. What Pipedream answered is not read: a 2xx said
 * only that Pipedream took the post.
 *
 * ONE MESSAGE A DAY to Main Flow's organization's alerts channel. A day with any
 * run that did not land, or could not be checked, or a check that could not run,
 * or a day Main Flow spent off the direct write (#2312), is titled as an alert
 * with a Fix line; otherwise it is a report. It arms no
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
import { MAIN_FLOW_WORKFLOW_ID, OUTCOME_POSTS, RELAY_OMITTED_KEYS, RELAY_RENAMES } from './main-flow-port/transform'
import { isSalesforceApiName, isSalesforceRecordId, salesforcePortFor } from './writeback-replay'
import { sameSalesforceValue } from './salesforce-field-conflict'
import { raceDeadline } from './alert-claim'
import { fetchAllPaged, PAGE_SIZE } from './paginate'
import { isUuidV7 } from '@bidspoke/uuidv7'
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

/** Relay posts read back from Salesforce per day, spread evenly over it. */
export const RELAY_SAMPLE_SIZE = 100

/** Relay posts listed per day, at most, before the sample is drawn. About 3,400 a day on 2026-10-17. */
export const MAX_RELAY_POSTS = 20_000

/** How long the relay reads may take in all; the rest of the sample is said as not checked. */
export const RELAY_READ_BUDGET_MS = 5 * 60_000

/** The run link every outcome post sends, on the relay and the direct write alike (#2313). */
export const RUN_LINK_FIELD = 'PDFlow_1__c'
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

/** One relay post of the eight other outcome steps, as its step recorded it. */
export interface RelayStep extends WatchedStep {
  step_namespace: string
}

export interface RelayReadBack {
  /** Relay posts of the eight other outcome steps in the window. */
  total: number
  /** The sample's verdicts, in the order read: what Salesforce saved, never what Pipedream answered. */
  sample: RunVerdict[]
  /** Sampled posts with no Submission to write, which the relay's filter stops: read for nothing. */
  noSubmission: number
}

export type RunVerdict =
  | { kind: 'landed'; executionId: string }
  | { kind: 'not_landed'; executionId: string; problems: string[] }
  | { kind: 'unchecked'; executionId: string; reason: string }
  /** A relay post's Submission holds a LATER Main Flow run's link: overwritten since, so not judged. */
  | { kind: 'superseded'; executionId: string; byExecutionId: string }

export interface CanaryWatchReport {
  from: string
  to: string
  /** The runs whose step ran natively and sent a write, in the order read. */
  native: RunVerdict[]
  /** Native steps that skipped the write, with the reason the step recorded. */
  skipped: Array<{ executionId: string; reason: string }>
  /** Steps of the watched post that went through the relay, in all. */
  relayInvalidState: number
  /** Of those, the ones that came after a direct post: Main Flow left the direct write. */
  relayAfterSwitch: number
  /** The day's last watched post went through the relay, so Main Flow is on the relay now. */
  lastWasRelay: boolean
  /** Of the native runs that sent a write, how many the step itself recorded as completed. */
  nativeCompleted: number
  relay: RelayReadBack | { error: string }
  /** The step read failed, so nothing was checked. */
  readError?: string
}

export interface CanaryWatchMessage {
  title: string
  lines: string[]
  fixHint?: string
  /** A run did not land, could not be checked, the check could not run, or Main Flow was off the direct write. */
  alert: boolean
}

export interface CanaryWatchDeps {
  now: () => number
  appUrl: string
  /**
   * Every step of the watched post in [from, to), test runs left out, OLDEST RUN
   * FIRST: whether a relay post is a rollback is read from the order (#2312).
   * Throws on a failed read.
   */
  readSteps: (fromIso: string, toIso: string) => Promise<WatchedStep[]>
  /**
   * The relay comparison's posts over [from, to): how many there were, and a
   * sample of RELAY_SAMPLE_SIZE spread evenly over the window (pickEvenly), oldest
   * first. Throws on a failed read.
   */
  readRelay: (fromIso: string, toIso: string) => Promise<{ total: number; sample: RelayStep[] }>
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

/** `n` of `items`, evenly spaced and in order, from the first; every item when there are no more than `n`. */
export function pickEvenly<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items]
  return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)])
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

/** One Submission write to read back: the run, its step, the record and the PATCH body as Salesforce received it. */
interface SubmissionWrite {
  executionId: string
  stepNamespace: string
  recordId: string
  sent: Record<string, unknown>
}

/** A native step's write, from what the step recorded (the body after the port's omit, rename and inject). */
function nativeWrite(step: WatchedStep): SubmissionWrite | { unchecked: string } {
  const resolved = asObject(asObject(step.input)?.resolved)
  const sent = asObject(resolved?.body)
  const recordId = resolved?.record_id
  if (!sent || typeof recordId !== 'string' || !isSalesforceRecordId(recordId)) {
    return { unchecked: 'The run did not record the Submission it wrote or what it sent.' }
  }
  return { executionId: step.execution_id, stepNamespace: WATCHED_STEP, recordId, sent }
}

/**
 * A relay post's write: the PATCH the Update Submission relay makes from what the
 * step posted, the body (a JSON text body parsed) with RELAY_OMITTED_KEYS dropped
 * and RELAY_RENAMES applied, to the body's own `submissionId`. The port's relay
 * parity test proves the native step sends the same PATCH, so the two sides are
 * judged on one body shape. A body with no `submissionId` is one the relay's
 * filter stops, so nothing was written.
 */
function relayWrite(step: RelayStep): SubmissionWrite | { unchecked: string } | { noSubmission: true } {
  let body: unknown = asObject(asObject(step.input)?.resolved)?.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return { unchecked: 'The run recorded a relay body that is not JSON, so what it sent cannot be known.' }
    }
  }
  const posted = asObject(body)
  if (!posted) return { unchecked: 'The run did not record what it posted to the relay.' }
  const recordId = posted.submissionId
  if (recordId === undefined || recordId === null || recordId === '') return { noSubmission: true }
  if (typeof recordId !== 'string' || !isSalesforceRecordId(recordId)) return { unchecked: 'The relay post named a Submission id Salesforce would not accept.' }
  const omitted: ReadonlySet<string> = new Set(RELAY_OMITTED_KEYS)
  const renames: Readonly<Record<string, string>> = RELAY_RENAMES
  const sent: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(posted)) if (!omitted.has(k)) sent[Object.hasOwn(renames, k) ? renames[k] : k] = v
  return { executionId: step.execution_id, stepNamespace: step.step_namespace, recordId, sent }
}

/**
 * The run whose link a Submission holds, when it is a Main Flow run other than
 * this one and LATER than it, so its write came after this one's. Execution ids
 * are UUIDv7, which sort by when they were minted; an id that is not one cannot
 * be ordered, and says null.
 */
function laterRunInLink(link: unknown, expectedLink: string, executionId: string): string | null {
  const prefix = expectedLink.slice(0, expectedLink.length - executionId.length)
  if (typeof link !== 'string' || !link.startsWith(prefix)) return null
  const other = link.slice(prefix.length)
  return other !== executionId && isUuidV7(other) && isUuidV7(executionId) && other > executionId ? other : null
}

/** One write's read-back. `stop` says Salesforce stopped answering. */
async function checkWrite(w: SubmissionWrite, read: Read, appUrl: string): Promise<{ verdict: RunVerdict; stop: boolean }> {
  const { executionId, sent, recordId } = w
  const unchecked = (reason: string, stop = false) => ({ verdict: { kind: 'unchecked' as const, executionId, reason }, stop })
  const expectedLink = bidspokeRunLink(appUrl, MAIN_FLOW_WORKFLOW_ID, executionId)
  if (!expectedLink) return unchecked('The app address is not set, so the run link cannot be compared.')
  const sentFields = Object.keys(sent).filter((k) => k !== WRITE_MARKER_FIELD && k !== RUN_LINK_FIELD)
  if (!sentFields.every(isSalesforceApiName)) return unchecked('The run sent a key that is not a Salesforce field name, so it was not read back.')
  const stamped = typeof sent[WRITE_MARKER_FIELD] === 'string'
  const sentEngineIds = SUB_UUID in sent && SUB_LEAD_UUID in sent

  const fields = [...new Set([...(stamped ? [WRITE_MARKER_FIELD] : []), RUN_LINK_FIELD, 'Lead__c', ...sentFields])]
  const sub = await readRecord(read, 'Submission', `/sobjects/Submission__c/${recordId}?fields=${fields.join(',')}`)
  if (sub.kind === 'unread') return unchecked(sub.reason, sub.stop)
  if (sub.kind === 'missing') return { verdict: { kind: 'not_landed', executionId, problems: ['The Submission does not exist in Salesforce.'] }, stop: false }
  const current = sub.body
  const link = current[RUN_LINK_FIELD]

  // With no stamp to say whose write the record holds, a later run's link means
  // this write was overwritten since, and what the record holds is that run's.
  if (!stamped) {
    const later = laterRunInLink(link, expectedLink, executionId)
    if (later) return { verdict: { kind: 'superseded', executionId, byExecutionId: later }, stop: false }
  }

  const problems: string[] = []
  if (stamped) {
    const stamp = parseWriteMarker(current[WRITE_MARKER_FIELD])
    if (!stamp) problems.push("The Submission does not carry this run's write stamp.")
    else if (stamp.executionId !== executionId || stamp.stepNamespace !== w.stepNamespace) {
      problems.push(`Another write has stamped the Submission since (run ${stamp.executionId}), so a difference below may be that write's.`)
    }
  }
  if (link === null || link === undefined || link === '') problems.push('The Submission has no Bidspoke run link.')
  else if (link !== expectedLink) problems.push("The Submission's Bidspoke run link is not this run's.")
  const differing = sentFields.filter((k) => sent[k] !== REDACTED && (!(k in current) || !sameSalesforceValue(current[k], sent[k]))).sort()
  if (differing.length > 0) {
    const n = differing.length
    problems.push(`${n} field${n === 1 ? ' holds' : 's hold'} a different value from the one the run sent: ${joinAnd(differing)}.`)
  }

  // The Lead copy is SubmissionService's, of the Engine ids this write sent.
  if (!sentEngineIds) return { verdict: problems.length === 0 ? { kind: 'landed', executionId } : { kind: 'not_landed', executionId, problems }, stop: false }
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
  const report: CanaryWatchReport = { from, to, native: [], skipped: [], relayInvalidState: 0, relayAfterSwitch: 0, lastWasRelay: false, nativeCompleted: 0, relay: { total: 0, sample: [], noSubmission: 0 } }
  const relayPromise = deps.readRelay(from, to).then(
    (r): { total: number; sample: RelayStep[] } | { error: string } => r,
    (e: unknown) => ({ error: formatErr(e) }),
  )
  let steps: WatchedStep[]
  try {
    steps = await deps.readSteps(from, to)
  } catch (e) {
    report.readError = formatErr(e)
    // The day's subject could not be read, so the comparison is not read back either.
    const relay = await relayPromise
    report.relay = 'error' in relay ? relay : { total: relay.total, sample: [], noSubmission: 0 }
    return report
  }
  const toRead: WatchedStep[] = []
  let sawDirect = false
  for (const s of steps) {
    if (s.step_type !== 'salesforce') {
      report.relayInvalidState++
      if (sawDirect) report.relayAfterSwitch++
      report.lastWasRelay = true
      continue
    }
    sawDirect = true
    report.lastWasRelay = false
    const out = asObject(s.output)
    if (out?.skipped === true) {
      report.skipped.push({ executionId: s.execution_id, reason: typeof out.skip_reason === 'string' ? out.skip_reason : 'unknown' })
      continue
    }
    if (s.status === 'completed') report.nativeCompleted++
    toRead.push(s)
  }

  const relay = await relayPromise
  const relayWrites: Array<SubmissionWrite | { executionId: string; unchecked: string }> = []
  let noSubmission = 0
  if (!('error' in relay)) {
    for (const s of relay.sample) {
      const w = relayWrite(s)
      if ('noSubmission' in w) noSubmission++
      else relayWrites.push('unchecked' in w ? { executionId: s.execution_id, unchecked: w.unchecked } : w)
    }
  }

  // One Salesforce, one circuit: the native runs first, then the relay sample.
  let read: Read | null = null
  let stopReason: string | null = null
  if (toRead.length > 0 || relayWrites.length > 0) {
    try {
      read = await deps.salesforce()
    } catch (e) {
      stopReason = `Salesforce settings could not be loaded (${formatErr(e)}).`
    }
  }
  const judge = async (w: SubmissionWrite): Promise<RunVerdict> => {
    if (!read || stopReason) return { kind: 'unchecked', executionId: w.executionId, reason: stopReason ?? 'Salesforce stopped answering earlier in this check.' }
    try {
      const { verdict, stop } = await checkWrite(w, read, deps.appUrl)
      if (stop) stopReason = 'Salesforce stopped answering earlier in this check.'
      return verdict
    } catch (e) {
      return { kind: 'unchecked', executionId: w.executionId, reason: `The check failed on this run (${formatErr(e)}).` }
    }
  }
  for (const s of toRead) {
    const w = nativeWrite(s)
    report.native.push('unchecked' in w ? { kind: 'unchecked', executionId: s.execution_id, reason: w.unchecked } : await judge(w))
  }

  if ('error' in relay) {
    report.relay = relay
    return report
  }
  const sample: RunVerdict[] = []
  const deadline = deps.now() + RELAY_READ_BUDGET_MS
  for (const w of relayWrites) {
    if ('unchecked' in w) sample.push({ kind: 'unchecked', executionId: w.executionId, reason: w.unchecked })
    else if (deps.now() >= deadline) sample.push({ kind: 'unchecked', executionId: w.executionId, reason: 'The relay reads ran out of time before this post.' })
    else sample.push(await judge(w))
  }
  report.relay = { total: relay.total, sample, noSubmission }
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

/**
 * The relay comparison, on the direct writes' own measure: of the posts read
 * back, how many Salesforce holds in full (#2313). Posts a later run overwrote,
 * and posts with no Submission, are said and left out of the rate.
 */
function relayLine(r: RelayReadBack, directRead: number, directLanded: number): string {
  const count = (k: RunVerdict['kind']) => r.sample.filter((v) => v.kind === k).length
  const landed = count('landed')
  const notLanded = count('not_landed')
  const unchecked = count('unchecked')
  const superseded = count('superseded')
  const judged = landed + notLanded + unchecked
  let line = `Over the same hours ${fmt(r.total)} of Main Flow's other outcome posts went through the relay.`
  const more = judged > 0 ? 'more' : 'of them'
  if (judged === 0) {
    if (superseded + r.noSubmission === 0) line += ' None of them were read back from Salesforce.'
  } else {
    const rest = [notLanded > 0 ? `${fmt(notLanded)} did not` : null, unchecked > 0 ? `${fmt(unchecked)} could not be checked` : null].filter((t): t is string => t !== null)
    line +=
      ` ${fmt(judged)} of them, spread over the day, ${judged === 1 ? 'was' : 'were'} read back from Salesforce the same way: ` +
      `${joinAnd([`${fmt(landed)} landed fully (${pct(landed, judged)})`, ...rest])}.`
  }
  if (superseded > 0) line += ` ${fmt(superseded)} ${more} ${superseded === 1 ? 'was' : 'were'} read back and left out because a later run wrote the same Submission.`
  if (r.noSubmission > 0) line += ` ${fmt(r.noSubmission)} ${more} had no Submission, so the relay wrote nothing.`
  if (directRead > 0) line += ` The direct writes on the same measure: ${fmt(directLanded)} of ${fmt(directRead)} landed fully (${pct(directLanded, directRead)}).`
  return line
}

/** The Fix line for a day Main Flow spent off the direct write (#2312). */
const ROLLBACK_FIX =
  "If Main Flow was rolled back on purpose, nothing else is needed. If not, open Main Flow's version history and see which version is live. Either way, the time on the relay is a gap in the week of direct writes being measured."

/** The day's message, separate from the send so the words can be tested. */
export function canaryWatchMessage(report: CanaryWatchReport, appUrl: string): CanaryWatchMessage {
  const span = `from ${etTime(report.from)} to ${etTime(report.to)}`
  if (report.readError) {
    return {
      title: 'Invalid state write check could not run',
      lines: [`The check could not read yesterday's Main Flow runs from the database (${report.readError}).`],
      fixHint: 'Check the database is answering. The check runs again tomorrow morning.',
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
  const r = report.relayInvalidState
  const posts = (k: number) => `${fmt(k)} invalid state post${k === 1 ? '' : 's'}`
  const offDirect = report.lastWasRelay || report.relayAfterSwitch > 0
  // Every direct post is either read back (native) or skipped, so neither means none went direct.
  const neverDirect = r > 0 && report.native.length === 0 && report.skipped.length === 0
  if (neverDirect) {
    lines.push(`${r === 1 ? 'The 1 invalid state post' : `All ${posts(r)}`} went through the relay, so Main Flow is not on the direct write.`)
  } else if (report.lastWasRelay) {
    lines.push(`${posts(r)} went through the relay, the last of them after every direct write, so Main Flow is back on the relay.`)
  } else {
    const before = r - report.relayAfterSwitch
    if (before > 0) lines.push(`${posts(before)} went through the relay before Main Flow moved to the direct write.`)
    if (report.relayAfterSwitch > 0) {
      lines.push(`${posts(report.relayAfterSwitch)} went through the relay between direct writes, so Main Flow left the direct write for a while and came back.`)
    }
  }

  const bad = report.native.filter((v) => v.kind !== 'landed')
  for (const v of bad.slice(0, MAX_LISTED_RUNS)) {
    lines.push(v.kind === 'not_landed' ? `${runLabel(appUrl, v.executionId)}: ${v.problems.join(' ')}` : `${runLabel(appUrl, v.executionId)} could not be checked: ${v.kind === 'unchecked' ? v.reason : ''}`)
  }
  if (bad.length > MAX_LISTED_RUNS) {
    lines.push(`${fmt(bad.length - MAX_LISTED_RUNS)} more runs did not land fully or could not be checked; the job run record lists them all.`)
  }

  if ('error' in report.relay) {
    lines.push(`The relay's posts could not be read from the database (${report.relay.error}).`)
  } else if (report.relay.total === 0) {
    lines.push('No other outcome post went through the relay in those hours, so there is nothing to compare against.')
  } else {
    lines.push(relayLine(report.relay, n, landed))
  }

  const alert = bad.length > 0 || offDirect
  let title: string
  if (notLanded > 0 && unchecked > 0) title = `${fmt(notLanded)} of ${fmt(n)} invalid state writes did not land in Salesforce, and ${fmt(unchecked)} could not be checked`
  else if (notLanded > 0) title = `${fmt(notLanded)} of ${fmt(n)} invalid state writes did not land in Salesforce`
  else if (unchecked > 0) title = `${fmt(unchecked)} of ${fmt(n)} invalid state writes could not be checked in Salesforce`
  // Not "back on" when nothing in the window went direct: the window cannot show it ever left.
  else if (neverDirect) title = 'Main Flow is not on the direct write for invalid state posts'
  else if (report.lastWasRelay) title = 'Main Flow is back on the relay for invalid state posts'
  else if (offDirect) title = 'Main Flow left the direct write for invalid state posts for a while'
  else if (n === 0) title = 'No invalid state writes to check yesterday'
  else title = n === 1 ? 'The invalid state write landed in Salesforce' : `All ${fmt(n)} invalid state writes landed in Salesforce`

  return {
    title,
    lines,
    ...(alert
      ? {
          fixHint: [
            notLanded > 0
              ? 'Open each run above and its Submission in Salesforce. If writes are being lost, roll Main Flow back to the relay with the saved rollback record.'
              : unchecked > 0
                ? 'Check Salesforce is answering and its login works. The check runs again tomorrow morning; check these runs by hand meanwhile.'
                : null,
            offDirect ? ROLLBACK_FIX : null,
          ]
            .filter((t): t is string => t !== null)
            .join(' '),
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
    outcome: !posted ? 'not_posted' : report.readError ? 'read_failed' : report.native.some((v) => v.kind !== 'landed') ? 'not_all_landed' : report.lastWasRelay || report.relayAfterSwitch > 0 ? 'off_direct_write' : report.native.length === 0 ? 'no_runs' : 'all_landed',
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
      relay_after_switch: report.relayAfterSwitch,
      last_was_relay: report.lastWasRelay,
      native_completed: report.nativeCompleted,
      relay:
        'error' in report.relay
          ? report.relay
          : {
              total: report.relay.total,
              read: report.relay.sample.length,
              no_submission: report.relay.noSubmission,
              landed: report.relay.sample.filter((v) => v.kind === 'landed').length,
              not_landed: report.relay.sample.filter((v) => v.kind === 'not_landed').length,
              unchecked: report.relay.sample.filter((v) => v.kind === 'unchecked').length,
              superseded: report.relay.sample.filter((v) => v.kind === 'superseded').length,
              // Run ids and what was wrong, never a value.
              runs: report.relay.sample.filter((v) => v.kind === 'not_landed' || v.kind === 'unchecked'),
            },
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
      `relay_invalid_state=${report.relayInvalidState} relay_after_switch=${report.relayAfterSwitch} last_was_relay=${report.lastWasRelay} posted=${posted}${report.readError ? ` read_error=${report.readError}` : ''}`,
  )
  try {
    await deps.recordRun?.(startedAtMs, endingOf(report, posted))
  } catch (e) {
    console.error(`[${INVALID_STATE_WATCH_JOB}] could not record its run:`, formatErr(e))
  }
  return report
}

/**
 * The relay comparison's posts in [from, to): every post's id, in time order, a
 * page at a time (PostgREST answers at most 1,000 rows), then the full rows of a
 * RELAY_SAMPLE_SIZE sample spread evenly over them, in that order. A day past
 * MAX_RELAY_POSTS throws rather than sampling part of it, and so does a sample
 * read that comes back short. Throws on a failed read.
 */
export async function readRelayPosts(supabase: SupabaseClient, from: string, to: string): Promise<{ total: number; sample: RelayStep[] }> {
  const relayPosts = (columns: string) =>
    // paginate-ok: a shared filter, never read on its own. Both callers below
    // bound it, the id list by fetchAllPaged's .range() and the sample by .limit().
    supabase
      .from('execution_steps')
      .select(columns)
      .eq('workflow_id', MAIN_FLOW_WORKFLOW_ID)
      .in('step_namespace', [...RELAY_COMPARISON_POSTS])
      .eq('step_type', 'webhook')
      .gte('execution_started_at', from)
      .lt('execution_started_at', to)
      .not('is_test', 'is', true)
  const ids = (
    await fetchAllPaged<{ id: string }>(
      (lo, hi) => relayPosts('id').order('execution_started_at', { ascending: true }).order('id', { ascending: true }).range(lo, hi),
      'relay post list',
      { maxPages: Math.ceil(MAX_RELAY_POSTS / PAGE_SIZE) },
    )
  ).map((r) => r.id)
  const picked = pickEvenly(ids, RELAY_SAMPLE_SIZE)
  if (picked.length === 0) return { total: 0, sample: [] }
  const { data, error } = await relayPosts('id, execution_id, step_namespace, step_type, status, input, output').in('id', picked).limit(RELAY_SAMPLE_SIZE)
  if (error) throw new Error(`relay sample read failed: ${error.message}`)
  const byId = new Map(((data ?? []) as unknown as Array<RelayStep & { id: string }>).map((r) => [r.id, r]))
  const sample = picked.map((id) => byId.get(id)).filter((r): r is RelayStep & { id: string } => r !== undefined)
  if (sample.length !== picked.length) throw new Error(`the relay sample read returned ${sample.length} of ${picked.length} posts`)
  return { total: ids.length, sample }
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
    readRelay: (from, to) => readRelayPosts(supabase, from, to),
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
