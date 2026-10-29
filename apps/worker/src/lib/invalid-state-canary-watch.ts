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
 * hours ending at 12:50 UTC, ten minutes before the batch (canaryWatchWindow),
 * so consecutive days tile and a run still writing its steps is read the next day.
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
 * LANDED, THEN MOVED ON (#2396). The 2026-10-18 report said 13 of 100 relay posts
 * did not land, and all 13 had: 11 differed only in the exchange status and its
 * timestamp, which the sale's own completion set 30 s to 2 min after the post,
 * and 2 only because the Lead had followed a newer Submission of the same
 * customer. So, on both halves alike: a post whose run link and every other
 * field match, whose only differing fields are LATER_WRITE_FIELDS holding what a
 * later write leaves, on a Submission last modified after the post began, was
 * superseded by a later write; and one whose Lead names a Submission created
 * after this one (returning-customer.ts, the lead status check's rule) and
 * carries that Submission's Engine ids followed a newer Submission. Both count
 * as landed fully and are said apart, in the message and the job run record.
 * Anything else that differs still reads as did not land.
 * A REPEAT VISIT (#2485). The 2026-10-19 report said 2 of 17 direct writes did
 * not land, and both were one customer's two runs 15 minutes apart writing the
 * same Submission. So: a direct write whose Submission holds the stamp of the
 * same step in a run whose write was SENT LATER (see SEND ORDER), and that
 * run's link, was overwritten by it and is set aside as superseded: said and
 * counted, and OVERWRITE_STORM_MIN or more in a day pages (L77). An earlier
 * sent run's stamp, or one that cannot be read, is still a write that did not
 * land. And SubmissionService copies the Engine ids to the Lead only when the
 * Submission first completes, so a Lead naming THIS Submission and holding the
 * ids an earlier sent run wrote to it (that day or the day before) holds that
 * first completion's copy; a Lead matching no run's ids is still a mismatch.
 * SEND ORDER (#2806, its second half). Salesforce keeps whichever write ARRIVED
 * last, which is not always the run that started last: on 2026-10-23 run
 * 01a1689d-3f57 started 1.6 s before 01a1689d-45b2 and sent its post 3.4 s
 * after it, and the relay sample counted 45b2 as not landed. So two runs on one
 * Submission are ordered by their posting steps' own times: a write reached
 * Salesforce between its step's start (the send) and its step's end (the
 * answer), and one write is later than another only when it was sent after the
 * other was answered. Writes whose spans overlap, a tie among them, cannot be
 * ordered. A run whose step rows are gone (purged) is bounded by its own start
 * instead: it sent nothing before it started, and nothing more than
 * SEND_BOUND_MS after. Any pair that leaves unordered is ORDER UNKNOWN: never
 * landed and never lost, counted and said apart with its reason (L540), and
 * OVERWRITE_STORM_MIN or more in a day pages, so missing send times cannot go
 * quiet. A relay post's span ends at Pipedream's answer; the relay's own PATCH
 * comes after it, and how long after is not measured here.
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
 * on the direct side it is checked as one more key sent.
 * THE INQUIRY RELAY WINNING THAT RACE (2026-10-27). The first send_salesforce
 * report said 11 of 200 sampled direct writes did not arrive complete, and all 11
 * had: each Submission held this run's stamp, run link and every other field
 * sent, and only PDFlow_4__c held a pipedream.com inspector link, on a record
 * modified 1 to 12 minutes after the write. Pipedream answers the inquiry post in
 * about 0.1 s and PATCHes afterwards on its own clock, and send_salesforce's
 * direct write comes 2 to 5 s after that post (invalid state's came 10 to 16 s
 * after), so Pipedream's PATCH sometimes arrives last. A pipedream.com link
 * there is therefore a LATER_WRITE_FIELDS rule like the sale's own completion:
 * landed, moved on since, counted (`inquiry_link_replaced`) and said apart. Any
 * other value there still reads as did not land. On a record holding this run's
 * own stamp it needs no time test, which Salesforce's whole seconds defeat when
 * the PATCH lands within 2 s (#2937, at supersededByLaterWrite). The rule ends
 * with the inquiry's own move (#2175).
 * ANOTHER USER CHANGING A FIELD AFTERWARDS (#3005). The 2026-10-29 report said
 * run 01a1837c-e25d-777a-ab77-bda0d3dd37ba did not arrive complete and told Dan
 * to move Main Flow back to Pipedream. It had arrived: its Submission held the
 * run's stamp and link, and Submission__History showed Bidspoke Integration
 * setting ADV_SO__c and XBC_SO__c at 17:09:29 UTC, inside the step, then
 * "integration halo", the website's API user, setting both back at 22:33:23.
 * Current values cannot tell a lost write from one overwritten later, so adding
 * those fields to LATER_WRITE_FIELDS was rejected. Instead, when a Submission
 * holds this run's own stamp and link and fields still differ, ONE history query
 * asks who changed them (changedAfterOwnWrite): a field whose history shows this
 * write's user setting the value sent inside the write's own span, then another
 * user setting what it holds now, landed and was changed afterwards, counted
 * (`changed_afterwards`) and said apart, never with a Fix line. A field with no
 * history, no row by the writing user, or a history that cannot be read still
 * did not land, and an unread history is said as such. Both subjects share it,
 * since both write the same Submission the website writes; a relay post carries
 * no stamp, so it never asks.
 * EVERY TIMED OUT WRITE (#2938). The 2026-10-28 send_salesforce report said
 * 1,208 leads were written directly. 9 of them timed out at the step's 5.25 s
 * deadline with no retry, and the report did not say so: its sample of 200 reads
 * a timed out write only by chance (all 9 had landed, read by hand). So every
 * direct write whose step timed out (stepTimeoutMs, the error the engine's step
 * deadline records, engine/retry.ts) is read back too, sampled or not, FIRST and
 * within the same read budget, and the message says how many timed out and what
 * reading each found: arrived complete, arrived only once the read-back sent it
 * again (its stamp's attempt), did not arrive complete, or could not be checked,
 * never lost (L11). Each that did not arrive, or could not be checked, is named
 * as timed out, and one that did not arrive leads the title. HOW MANY: they are
 * among the day's steps already read, so no further database read; 9 of 1,208 on
 * 2026-10-28, and OUTCOME_WRITE_TIMEOUT_MS expects 1 or 2 in 1,000, so about ten
 * more Salesforce reads (about 5 s) a day. A Salesforce slowdown can time out
 * every write, at most the subject's maxSteps (5,000), but a sampled subject's
 * reads stop at DIRECT_READ_BUDGET_MS (about 600 at half a second each) and the
 * rest are said as could not be checked, so the morning run is no longer than
 * before; the invalid state subject reads every write already. A timed out
 * step ended when Bidspoke stopped waiting, not when Salesforce answered, so
 * SEND ORDER bounds its write as one with no answer recorded.
 *
 * NOT CHECKED HERE, from #2173's acceptance: that fields the body did not send
 * are unchanged (that needs a snapshot taken before the write, which only the
 * run could take), and Regal's Lead fields. Those are read by hand.
 *
 * THE RELAY COMPARISON (#2313) is what Salesforce SAVED for the relay posts of
 * the outcome posts no subject watches (seven since #2174) in the same window,
 * read back the same way: a
 * sample of RELAY_SAMPLE_SIZE posts spread evenly over the day (the relay makes
 * about 3,400 a day, so all of them would be thousands of reads), each judged by
 * the relay's own PATCH, the body with `executionId` and `submissionId` dropped
 * and `UUID` and `leadUUID` renamed, as the port reproduces it. A relay post
 * carries no write stamp, so a Submission holding the link of a Main Flow run
 * whose write was sent later was overwritten since and is left out, one holding
 * an earlier sent run's link means this post never landed, and one whose order
 * cannot be told is order unknown (SEND ORDER). What Pipedream answered is not
 * read: a 2xx said only that Pipedream took the post.
 * A RELAY POST WHOSE STEP FAILED (#2939). The 2026-10-28 reports counted run
 * 01a18160-b7e9-7e54-a11a-87c69b02a7ae as could not be checked: its
 * engine_no_bids_sf_post timed out three times and, like every failed webhook
 * step (the webhook executor attaches no request to its error), recorded no
 * input, so there was no body and no Submission to read. Its Submission held no
 * run link: the outcome never reached Salesforce. So a sampled relay post whose
 * step failed with nothing recorded is read back by its run link alone, on the
 * Submission its run's trigger payload names (`Submission__c`, where every
 * compared post's body takes its `submissionId`, checked against the production
 * definition in canary-watch-relay-failed-post.test.ts; one database read for
 * the day's few, readRunSubmissions). Every outcome post sends the run link and
 * Salesforce saves one PATCH whole or not at all, so: this run's link means it
 * arrived, its fields not compared (`arrived_unrecorded`); no sign of it (no
 * link, an earlier sent run's link, or no Submission) means it is not in
 * Salesforce and counts as did not, against Pipedream. A step that failed
 * outright is then NEVER SENT; one that timed out is NOT FOUND, never "never
 * sent", because Pipedream may have taken it after Bidspoke stopped waiting
 * (L11). A later run's link, or one that cannot be ordered, is set aside as for
 * any relay post, and a read that fails, of Salesforce or the database, is could
 * not be checked. A post that recorded nothing and did not fail is still could
 * not be checked: nothing says what happened to it.
 *
 * ONE MESSAGE A DAY to Main Flow's organization's alerts channel. A day with any
 * run that did not land, or could not be checked, or a check that could not run,
 * or a day Main Flow spent off the direct write (#2312), or an overwrite storm
 * (#2485), or a pile of writes that could not be ordered against another run's
 * (#2806), is titled as an alert with a Fix line; otherwise it is a report. It arms no
 * all-clear marker, because the next day's message is the stand down, so it has
 * no INCIDENT_SIGNALS entry.
 *
 * A SECOND SUBJECT (#2174, the phase 5 canary). The same check runs as its own
 * job on `send_salesforce`, the busiest outcome post and a JSON text body
 * (CanaryWatchSubject; one message and one job run each). Three things differ,
 * each a field of its subject rather than a second copy of the check:
 *  - it runs about 1,271 times a day, and one Salesforce read took about half a
 *    second in the first canary's runs (230 reads in 57 to 229 s), so reading
 *    every write would outrun the morning run. A sample of DIRECT_SAMPLE_SIZE
 *    spread evenly over the day is read, within DIRECT_READ_BUDGET_MS, and the
 *    message says how many were written and how many were checked;
 *  - its body sends no Engine ids, so it reads no Lead and claims none;
 *  - it is switched on by applying the port's `canary_send_salesforce` stage,
 *    a separate step, so it posts nothing and records the day as not switched
 *    on while all three hold: Main Flow does not hold that port, none of its
 *    posts went direct in the window, and this job has never posted a day. Any
 *    one of them makes it report: a direct write in the window whatever the live
 *    definition says, because a canvas save that undid the port is a rollback
 *    (#2312), and a job that has posted before, so a rollback is said every day.
 * The relay comparison leaves out every subject's post.
 *
 * WINDOWS TILE (#2806, its first half). The window ends at 12:50 UTC, ten
 * minutes before the daily batch, whenever the run starts: on 2026-10-22 the run
 * started 31 minutes late and the window measured back from its start left
 * 8:52 to 9:23 AM ET unread. Its second half is SEND ORDER above.
 *
 * REMOVING IT. Both subjects end with the canaries: the phase 6 pull request
 * (#2175, which moves the other seven posts and so leaves no relay to compare
 * against) deletes this file, its tests, both CRON_JOBS entries and both
 * blocks in index.ts. The steps are in docs/main-flow-relay-port.md. Until then,
 * a day on which no other post went through the relay says so.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import { bidspokeRunLink } from '../engine/context'
import type { SalesforceRead } from '../engine/inquiry-post'
import { ENGINE_ATTEMPT, parseWriteMarker, WRITE_MARKER_FIELD } from '../engine/write-marker'
import { stepTimeoutMs } from '../engine/retry'
import { MAIN_FLOW_WORKFLOW_ID, OUTCOME_POSTS, RELAY_OMITTED_KEYS, RELAY_RENAMES, portStatus, type Definition, type OutcomePost } from './main-flow-port/transform'
import { isSalesforceApiName, isSalesforceRecordId, salesforcePortFor } from './writeback-replay'
import { FIELD_HISTORY_ROW_LIMIT, LAST_MODIFIED_MARGIN_MS, queryRecords, salesforceTimeMs, sameSalesforceValue, soqlTime } from './salesforce-field-conflict'
import { leadNamesAnotherSubmission, leadNamesSubmission } from './returning-customer'
import { raceDeadline } from './alert-claim'
import { fetchAllPaged, PAGE_SIZE } from './paginate'
import { mintedMsFromUuidV7 } from '@bidspoke/uuidv7'
import { secretKeys } from './secret-crypto'
import { formatErr } from './format-error'
import { recordFinishedJobRun, type JobRunEnding } from './job-run-record'
import { getSlackConnection, postMessage } from './slack'
import type { SlackAlertKind } from './slack-post-outcome'

export const INVALID_STATE_WATCH_JOB = 'invalid-state-canary-watch'
export const SEND_SALESFORCE_WATCH_JOB = 'send-salesforce-canary-watch'

/** The first subject's post, the phase 4 canary. */
export const WATCHED_STEP = 'invalid_state_sf_post'

/**
 * One canary post this check reads back, and the words its message uses. Every
 * difference between the two canaries is a field here, so there is one check.
 */
export interface CanaryWatchSubject {
  /** Its job_runs and heartbeat name. */
  job: string
  step: OutcomePost
  /** Every title starts with this, so the day's message is recognisable at a glance. */
  title: string
  /** The first paragraph: what is being tried, and why Pipedream is compared (#2652). */
  intro: string
  /** One of its posts and several, as the message counts them. */
  outcome: { one: string; many: string }
  /** Direct writes read back per day, spread evenly over it; null reads every one. */
  sampleSize: number | null
  /** How long the direct reads may take in all, or null for no bound; the rest are said as not checked. */
  readBudgetMs: number | null
  /** Its body sends the Engine ids, so the Lead's copy of them is checked too. */
  checksLead: boolean
  /** Steps of its post read per day, at most. */
  maxSteps: number
  /** The fixed kind its daily message is logged under (#2948). */
  alertKind: SlackAlertKind
}

/** Direct send_salesforce writes read back per day (#2174): about 1,271 ran a day, too many to read every one. */
export const DIRECT_SAMPLE_SIZE = 200

/** How long a sampled subject's direct reads may take in all, the relay reads' own bound. */
export const DIRECT_READ_BUDGET_MS = 5 * 60_000

/**
 * When Main Flow version 172 went live, 2026-10-16 23:20 UTC (7:20 PM ET on Oct
 * 16): from then on its invalid_state_sf_post writes straight to Salesforce. The
 * message's first paragraph names the day from this (#2652).
 */
export const DIRECT_WRITE_SINCE = '2026-10-16T23:20:00.000Z'

const ET_ZONE = 'America/New_York'
/** A day in ET, as "Oct 16". */
const etDay = (at: string) => new Intl.DateTimeFormat('en-US', { timeZone: ET_ZONE, month: 'short', day: 'numeric' }).format(new Date(at))

export const INVALID_STATE_SUBJECT: CanaryWatchSubject = {
  job: INVALID_STATE_WATCH_JOB,
  alertKind: 'invalid-state-canary-watch',
  step: WATCHED_STEP,
  title: 'Direct Salesforce writes',
  intro: `Since ${etDay(DIRECT_WRITE_SINCE)}, Main Flow writes the outcome for leads from states we don't serve straight to Salesforce, while most other outcomes still go through Pipedream.`,
  outcome: { one: "outcome for a lead from a state we don't serve", many: "outcomes for leads from states we don't serve" },
  sampleSize: null,
  readBudgetMs: null,
  checksLead: true,
  // About 19 a day ran in the week before the canary.
  maxSteps: 1000,
}

/**
 * The phase 5 canary (#2174). Its body is a JSON text template with no `UUID` or
 * `leadUUID` key (Main Flow version 174, read 2026-10-26), so no Engine ids.
 */
export const SEND_SALESFORCE_SUBJECT: CanaryWatchSubject = {
  job: SEND_SALESFORCE_WATCH_JOB,
  alertKind: 'send-salesforce-canary-watch',
  step: 'send_salesforce',
  title: 'Direct Send Salesforce writes',
  intro: 'Main Flow writes the outcome of its Send Salesforce step straight to Salesforce, while most other outcomes still go through Pipedream.',
  outcome: { one: 'Send Salesforce outcome', many: 'Send Salesforce outcomes' },
  sampleSize: DIRECT_SAMPLE_SIZE,
  readBudgetMs: DIRECT_READ_BUDGET_MS,
  checksLead: false,
  // 1,034 in the 24 hours to 2026-10-26 17:30 UTC; about 1,271 a day by #2174.
  maxSteps: 5000,
}

export const CANARY_WATCH_SUBJECTS: readonly CanaryWatchSubject[] = [INVALID_STATE_SUBJECT, SEND_SALESFORCE_SUBJECT]

/** The posts still on the relay, the comparison: every outcome post no subject watches. */
export const RELAY_COMPARISON_POSTS: readonly string[] = OUTCOME_POSTS.filter((p) => !CANARY_WATCH_SUBJECTS.some((s) => s.step === p))

/**
 * The window ends at this time of the UTC day, ten minutes before the daily
 * batch (`0 13 * * *`), so a run still recording its steps is read the next day.
 */
export const WINDOW_END_UTC_MINUTES = 12 * 60 + 50

const DAY_MS = 24 * 60 * 60_000

/** How long one Salesforce read may take, the read-back's own bound (SF_CALL_DEADLINE_MS). */
export const SF_READ_DEADLINE_MS = 12_000

/**
 * An overwrite storm (#2485, L77): at least this many direct writes in a day set
 * aside because a later run of Main Flow wrote the same Submission, and at least
 * OVERWRITE_STORM_SHARE of the day's direct writes, pages. One customer coming
 * back is ordinary: 1 Submission written twice in 116 invalid state posts over
 * the 8 days to 2026-10-19, about 15 a day. Three in a day is twenty times that.
 */
export const OVERWRITE_STORM_MIN = 3
export const OVERWRITE_STORM_SHARE = 0.1

/**
 * How long after its run starts an outcome post is sent and answered, at most
 * (#2806): the bound on a write whose step rows are gone, and on a step that
 * recorded no answer time. Measured on 2026-10-26 over the 20,008 outcome post
 * steps of the 7 days before: the latest answer came 53.5 s after its run
 * started, and the longest step took 10.2 s.
 */
export const SEND_BOUND_MS = 10 * 60_000

/** How far before its run's start a step's own clock may put it: the margin the send time read allows below the start. */
const SEND_READ_MARGIN_MS = 60_000

/** Rows the send time read takes for one run, at most: one per outcome post with room for retries. */
const SEND_READ_LIMIT = 50

/** Runs named one by one in the message; the rest are counted. */
export const MAX_LISTED_RUNS = 15

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
/** The Submission a Lead follows: its customer's newest (returning-customer.ts). */
const LEAD_SUBMISSION = 'Submission_Object_ID__c'

/**
 * The fields a LATER write may change after a post landed, and what that write
 * leaves in each (#2396). On 2026-10-18, 11 of 100 sampled relay posts read as
 * not landed only because External_Exchange_Status__c said Completed where the
 * relay sent Pending, and External_Timestamp__c held a time 30 s to 2 min after
 * the one sent: the sale's own completion writes the exchange status and stamps
 * when. These two only. Every other field a post sends is the post's own data
 * (scores, routing, the run link, the Engine ids), which no later write was seen
 * to change, so a difference there still reads as not landed. A later write
 * leaves a status set, never cleared, and moves its timestamp forward, never back.
 */
const LATER_WRITE_FIELDS: Readonly<Record<string, 'set' | 'later' | 'inquiry_link'>> = {
  External_Exchange_Status__c: 'set',
  External_Timestamp__c: 'later',
  // The inquiry relay's own PATCH (2026-10-27): it writes PDFlow_4__c with a
  // pipedream.com inspector link on every run, Pipedream answering the post in
  // about 0.1 s and PATCHing afterwards on its own clock. send_salesforce's direct
  // write comes 2 to 5 s after that post, so Pipedream's PATCH arrives last about
  // 1 time in 20 (11 of 200 sampled on 2026-10-27, every other field saved).
  // #2313 kept PDFlow_4__c as a key to judge when the only direct write came 10
  // to 16 s after the inquiry; it ends when the inquiry moves too (#2175).
  PDFlow_4__c: 'inquiry_link',
}

/** The fields a sale's own completion moves on (#2396), as opposed to the inquiry relay's link. */
const SALE_COMPLETION_FIELDS: ReadonlySet<string> = new Set(['External_Exchange_Status__c', 'External_Timestamp__c'])

/** The inquiry relay's link: an https link on pipedream.com itself, never a lookalike host. */
function isPipedreamLink(v: unknown): boolean {
  if (typeof v !== 'string') return false
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && u.hostname === 'pipedream.com'
  } catch {
    return false
  }
}
/** A value the step logger's PII scrub replaced: what was sent cannot be known from it. */
const REDACTED = '[REDACTED]'

export interface WatchedStep {
  execution_id: string
  step_type: string
  status: string
  /** When the step began: a Submission last written after it was written since the post began (#2396), and when the write was sent (#2806). */
  started_at: string
  /** When the step ended, so when its write had been answered (#2806). Absent or null: SEND_BOUND_MS after the send. */
  completed_at?: string | null
  /** The step's error. A step that timed out at its own deadline says so here (stepTimeoutMs, #2938). */
  error_message?: string | null
  input: unknown
  output: unknown
}

/** The step columns both reads select, so neither can drop the times a write is judged and ordered by, or whether it timed out. */
export const STEP_COLUMNS = 'execution_id, step_type, status, started_at, completed_at, error_message, input, output'

/** One outcome post step of a run, as the send order reads it (#2806). */
export interface SendStep {
  execution_id: string
  step_namespace: string
  started_at: string | null
  completed_at?: string | null
  /** A step that timed out recorded when Bidspoke stopped waiting, not an answer (#2938). */
  error_message?: string | null
}

/** One relay post of the eight other outcome steps, as its step recorded it. */
export interface RelayStep extends WatchedStep {
  step_namespace: string
}

export interface RelayReadBack {
  /** Relay posts of the eight other outcome steps in the window. */
  total: number
  /** The sample's verdicts, in the order read: what Salesforce saved, never what Pipedream answered. */
  sample: RelayVerdict[]
  /** Sampled posts with no Submission to write, which the relay's filter stops: read for nothing. */
  noSubmission: number
}

export type RunVerdict =
  /**
   * `resent` (#2938): the Submission holds this write's stamp from a resend
   * (attempt 1 or 2), so it arrived only when the Salesforce read-back sent it
   * again, never from the run's own send.
   */
  | { kind: 'landed'; executionId: string; resent?: true }
  /**
   * `problems` are plain word clauses, joined into one sentence by the message,
   * naming no field by its API name (#2652). `fields` keeps, for the job run
   * record, which fields held a different value (names, never values), and
   * `stampedBy` the run whose write stamp the Submission holds instead.
   */
  | { kind: 'not_landed'; executionId: string; problems: string[]; fields?: string[]; stampedBy?: string }
  /**
   * Landed, then moved on (#2396): every field sent was saved, and since then a
   * later write changed `laterWrite` (LATER_WRITE_FIELDS only), or the Lead has
   * followed a newer Submission of the same customer, or both. Counted as landed
   * fully, and said apart. `leadFromEarlierRun` (#2485): the Lead names this
   * Submission and holds the Engine ids that EARLIER run wrote to it, the copy
   * Salesforce makes only at a Submission's first completion.
   * `changedAfterwards` (#3005): fields the Submission's field history shows this
   * write setting, then another Salesforce user setting to what they hold now.
   */
  | { kind: 'moved_on'; executionId: string; laterWrite: string[]; newerSubmission: boolean; leadFromEarlierRun?: string; changedAfterwards?: ChangedAfterwards[]; resent?: true }
  | { kind: 'unchecked'; executionId: string; reason: string }
  /**
   * Overwritten since by a LATER Main Flow run's write to the same Submission, so
   * not judged: a relay post whose Submission holds that run's link, or a direct
   * write whose Submission holds that run's stamp and link (#2485). Said and
   * counted, never dropped.
   */
  | { kind: 'superseded'; executionId: string; byExecutionId: string }
  /**
   * Another Main Flow run wrote the same Submission, and which of the two writes
   * arrived last cannot be told (#2806): their sends overlap, or a send time is
   * not recorded and the runs' starts do not settle it. Not judged, never lost:
   * said and counted with `reason`, a clause naming what was missing.
   */
  | { kind: 'order_unknown'; executionId: string; otherExecutionId: string; reason: string }

/**
 * A sampled relay post whose step failed and recorded nothing it sent (#2939),
 * judged by its run link on the Submission its run's trigger names. `problems`
 * say what the Submission holds instead, for the job run record.
 */
export type FailedPostVerdict =
  /** The step failed outright, and Salesforce holds no sign of the post. */
  | { kind: 'never_sent'; executionId: string; problems: string[] }
  /** The step timed out, and Salesforce held no sign of the post when read; Pipedream may still have taken it. */
  | { kind: 'not_found'; executionId: string; problems: string[] }
  /** The Submission holds this run's link, so the post arrived; what it sent was not recorded to compare. */
  | { kind: 'arrived_unrecorded'; executionId: string }

/** What a relay post read back found: a direct write's verdicts, and a failed post's (#2939). */
export type RelayVerdict = RunVerdict | FailedPostVerdict

type Unchecked = Extract<RunVerdict, { kind: 'unchecked' }>

export interface CanaryWatchReport {
  from: string
  to: string
  /** The runs whose step ran natively and sent a write, in the order read, those a later run overwrote among them. */
  native: RunVerdict[]
  /**
   * How many native runs sent a write, all of them, when `native` holds only the
   * sample read back (a sampled subject, #2174). Absent means `native` is all.
   */
  nativeWrites?: number
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
  /**
   * Every native write whose step timed out at its own deadline (#2938), read
   * back whether or not the sample picked it: the verdicts in the order read, a
   * write the sample also holds being the same verdict, read once. `limitsMs`
   * holds each deadline they timed out at, once. Absent when the day's steps
   * were not read; empty verdicts on a day none timed out.
   */
  timedOut?: TimedOutReadBack
  relay: RelayReadBack | { error: string }
  /** The step read failed, so nothing was checked. */
  readError?: string
  /** Main Flow does not hold this subject's port and none of its posts went direct, so nothing was read or posted (#2174). */
  notSwitchedOn?: true
}

export interface TimedOutReadBack {
  verdicts: RunVerdict[]
  limitsMs: number[]
}

export interface CanaryWatchMessage {
  title: string
  lines: string[]
  fixHint?: string
  /** A run did not land, could not be checked, the check could not run, Main Flow was off the direct write, an overwrite storm, or a pile of writes that could not be ordered. */
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
  /**
   * The outcome post steps of one Main Flow run, with their send and answer
   * times (#2806), asked only for a run the day's own steps do not hold, when a
   * Submission holds that run's write. An empty answer means its rows are gone.
   * Throws on a failed read.
   */
  readSendSteps: (executionId: string) => Promise<SendStep[]>
  /**
   * The `Submission__c` each run's trigger payload holds, for the sampled relay
   * posts whose step failed and recorded nothing it sent (#2939), runs started
   * in [from, to). A run the database does not hold is absent from the map; one
   * whose trigger named no Submission maps to null. Throws on a failed read.
   */
  readRunSubmissions: (executionIds: string[], fromIso: string, toIso: string) => Promise<Map<string, unknown>>
  /**
   * Whether the live Main Flow holds this subject's port (portStatus), read
   * before anything else. Absent, or a read that throws, counts as holding it, so
   * a day is reported rather than silenced.
   */
  livePorted?: () => Promise<boolean>
  /**
   * Whether any step of the watched post in [from, to) ran natively, asked only
   * when the live Main Flow does not hold the port. Absent, or a read that
   * throws, counts as yes.
   */
  anyDirect?: (fromIso: string, toIso: string) => Promise<boolean>
  /**
   * Whether this subject's check has ever posted a day (a job run other than
   * not_switched_on), asked only when neither of the two above says yes. Once it
   * has, it never goes quiet again: a canary rolled back keeps saying so every
   * day, as the first one always did. Absent, or a read that throws, counts as yes.
   */
  reportedBefore?: () => Promise<boolean>
  /** Main Flow's Salesforce, as one read: `path` below `/services/data/v60.0`. Throws when its settings cannot be loaded. */
  salesforce: () => Promise<(path: string) => Promise<SalesforceRead>>
  /** Posts the message. True when Slack took it. */
  post: (message: CanaryWatchMessage, alertKind: SlackAlertKind) => Promise<boolean>
  recordRun?: (startedAtMs: number, ending: JobRunEnding) => Promise<void>
}

/**
 * The 24 hours the run at `nowMs` reads: those ending at the last 12:50 UTC at
 * or before it (#2806). A late run reads the same day as one on time, so
 * consecutive days meet exactly, whatever time each run starts.
 */
export function canaryWatchWindow(nowMs: number): { from: string; to: string } {
  const day = new Date(nowMs)
  let to = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) + WINDOW_END_UTC_MINUTES * 60_000
  if (to > nowMs) to -= DAY_MS
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
  /**
   * A relay post is judged overwritten by a later run's link alone; a direct
   * write only when its Submission also holds that later run's stamp of the same
   * step (#2485), and an unstamped one never.
   */
  via: 'direct' | 'relay'
  executionId: string
  stepNamespace: string
  recordId: string
  sent: Record<string, unknown>
  /** When the step that posted began, as it recorded it. */
  startedAt: string
  /** When the write may have reached Salesforce (#2806): its step's span, or its run's when the step recorded no start. */
  sentWithin: SentWithin
}

/**
 * The span of time a write reached Salesforce within, whether it is the step's
 * own (`recorded`) or only its run's bound, and whether a step of it timed out
 * (#2938), so its span runs to the bound however soon Bidspoke stopped waiting.
 */
interface SentWithin {
  spans: Array<{ from: number; to: number }>
  recorded: boolean
  timedOut: boolean
}

/** A step as a send time is read from: its start, its end, and its error. */
type SpanStep = { started_at: unknown; completed_at?: unknown; error_message?: unknown }

/**
 * A step's span: from its start, the send, to its end, the answer, or
 * SEND_BOUND_MS on when it recorded none. Null with no start. A step that timed
 * out at its own deadline (#2938) ended when Bidspoke stopped waiting, not when
 * Salesforce answered, and its write can still land after that (23 of 42 timed
 * out reject patches did, #2163), so it is bounded as one with no answer.
 */
function stepSpan(step: SpanStep): { from: number; to: number } | null {
  const from = typeof step.started_at === 'string' && step.started_at !== '' ? Date.parse(step.started_at) : Number.NaN
  if (!Number.isFinite(from)) return null
  const answered = stepTimeoutMs(step.error_message) === null ? step.completed_at : null
  const to = typeof answered === 'string' && answered !== '' ? Date.parse(answered) : Number.NaN
  return { from, to: Number.isFinite(to) && to >= from ? to : from + SEND_BOUND_MS }
}

/** A run's writes, from the steps recorded, or else from its own start: none before it, none more than SEND_BOUND_MS after. */
function sentWithin(executionId: string, steps: readonly SpanStep[]): SentWithin {
  const spans = steps.map(stepSpan).filter((s): s is { from: number; to: number } => s !== null)
  const timedOut = steps.some((s) => stepTimeoutMs(s.error_message) !== null)
  if (spans.length > 0) return { spans, recorded: true, timedOut }
  const minted = mintedMsFromUuidV7(executionId)
  return { spans: minted === null ? [] : [{ from: minted, to: minted + SEND_BOUND_MS }], recorded: false, timedOut }
}

/** How another run's write falls against this one's: sent after this one was answered, answered before this one was sent, or neither. */
type SendOrder = { order: 'later' | 'earlier' } | { order: 'unknown'; reason: string }

/** The reasons an order cannot be told, as clauses for the message (#2806). */
export const ORDER_UNKNOWN_REASONS = {
  overlap: 'the two were sent at nearly the same time',
  otherUnrecorded: "that run's send time is not recorded",
  ownUnrecorded: "this run's send time is not recorded",
  ownTimedOut: "this run's write timed out, so when it reached Salesforce is not known",
  otherTimedOut: "that run's write timed out, so when it reached Salesforce is not known",
} as const

/**
 * Where `other`'s writes fall against `mine` (#2806). Later when any of them was
 * sent after mine was answered, so Salesforce had mine first; earlier when all
 * of them were answered before mine was sent; otherwise unknown, with the
 * reason. Never decided on a guess: overlapping spans, a tie among them, are
 * unknown.
 */
function sendOrder(other: SentWithin, mine: SentWithin): SendOrder {
  const [m] = mine.spans
  if (m && other.spans.some((s) => s.from > m.to)) return { order: 'later' }
  if (m && other.spans.length > 0 && other.spans.every((s) => s.to < m.from)) return { order: 'earlier' }
  const reason = !mine.recorded
    ? ORDER_UNKNOWN_REASONS.ownUnrecorded
    : !other.recorded
      ? ORDER_UNKNOWN_REASONS.otherUnrecorded
      : mine.timedOut
        ? ORDER_UNKNOWN_REASONS.ownTimedOut
        : other.timedOut
          ? ORDER_UNKNOWN_REASONS.otherTimedOut
          : ORDER_UNKNOWN_REASONS.overlap
  return { order: 'unknown', reason }
}

/**
 * Where run `other`'s writes of `stepNamespace` (any outcome post when null)
 * fall against write `w` (#2806). Throws when its send times could not be read.
 */
type SendOrderLookup = (other: string, stepNamespace: string | null, w: Pick<SubmissionWrite, 'sentWithin'>) => Promise<SendOrder>

/** A native step's write, from what the step recorded (the body after the port's omit, rename and inject). */
function nativeWrite(step: WatchedStep, stepNamespace: string): SubmissionWrite | { unchecked: string } {
  const resolved = asObject(asObject(step.input)?.resolved)
  const sent = asObject(resolved?.body)
  const recordId = resolved?.record_id
  if (!sent || typeof recordId !== 'string' || !isSalesforceRecordId(recordId)) {
    return { unchecked: 'The run did not record the Submission it wrote or what it sent.' }
  }
  return { via: 'direct', executionId: step.execution_id, stepNamespace, recordId, sent, startedAt: step.started_at, sentWithin: sentWithin(step.execution_id, [step]) }
}

/**
 * A relay post's write: the PATCH the Update Submission relay makes from what the
 * step posted, the body (a JSON text body parsed) with RELAY_OMITTED_KEYS dropped
 * and RELAY_RENAMES applied, to the body's own `submissionId`. The port's relay
 * parity test proves the native step sends the same PATCH, so the two sides are
 * judged on one body shape. A body with no `submissionId` is one the relay's
 * filter stops, so nothing was written. A step that failed with no body
 * recorded is judged by its run link alone (#2939, checkFailedPost).
 */
function relayWrite(step: RelayStep): SubmissionWrite | { unchecked: string } | { noSubmission: true } | { failedUnrecorded: true } {
  const resolved = asObject(asObject(step.input)?.resolved)
  if (step.status === 'failed' && (!resolved || resolved.body === undefined || resolved.body === null)) return { failedUnrecorded: true }
  let body: unknown = resolved?.body
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
  return { via: 'relay', executionId: step.execution_id, stepNamespace: step.step_namespace, recordId, sent, startedAt: step.started_at, sentWithin: sentWithin(step.execution_id, [step]) }
}

/**
 * The other Main Flow run whose link a Submission holds: a run id (a UUIDv7)
 * other than this run's under the same workflow link. Null for this run's own
 * link, or anything else.
 */
function otherRunInLink(link: unknown, expectedLink: string, executionId: string): string | null {
  const prefix = expectedLink.slice(0, expectedLink.length - executionId.length)
  if (typeof link !== 'string' || !link.startsWith(prefix)) return null
  const other = link.slice(prefix.length)
  return other !== executionId && mintedMsFromUuidV7(other) !== null ? other : null
}

/**
 * The other run whose Engine ids a Lead holds (#2485): a run of the watched
 * post that wrote the same Submission with exactly those ids, and whose write
 * was sent before `w`'s (`earlier`) or cannot be ordered against it
 * (`unknown`, #2806). An earlier one wins over an unknown one. Null when none
 * did. Throws when the runs it must look through could not be read.
 */
type EarlierRunLookup = (w: SubmissionWrite, leadIds: Record<string, unknown>) => Promise<EarlierRun | null>
type EarlierRun = { run: string; order: 'earlier' } | { run: string; order: 'unknown'; reason: string }

/** Whether `other` is another write to the same Submission that sent the Engine ids `leadIds` holds, neither blank. */
function sentTheLeadsIds(other: SubmissionWrite, w: SubmissionWrite, leadIds: Record<string, unknown>): boolean {
  const blank = (v: unknown) => v === null || v === undefined || v === ''
  const [uuid, lead] = [leadIds[LEAD_UUID], leadIds[LEAD_LEAD_UUID]]
  return (
    other.executionId !== w.executionId &&
    leadNamesSubmission(other.recordId, w.recordId) &&
    !blank(uuid) &&
    !blank(lead) &&
    sameSalesforceValue(uuid, other.sent[SUB_UUID]) &&
    sameSalesforceValue(lead, other.sent[SUB_LEAD_UUID])
  )
}

/** Of `writes`, the one whose Engine ids the Lead holds and that was sent before `w`, else one that cannot be ordered against it. */
function earlierRunAmong(writes: readonly SubmissionWrite[], w: SubmissionWrite, leadIds: Record<string, unknown>): EarlierRun | null {
  let unknown: EarlierRun | null = null
  for (const e of writes) {
    if (!sentTheLeadsIds(e, w, leadIds)) continue
    const o = sendOrder(e.sentWithin, w.sentWithin)
    if (o.order === 'earlier') return { run: e.executionId, order: 'earlier' }
    if (o.order === 'unknown') unknown ??= { run: e.executionId, order: 'unknown', reason: o.reason }
  }
  return unknown
}

/**
 * Whether every field in `differing` is one a later write explains (#2396): each
 * is in LATER_WRITE_FIELDS and holds what such a write leaves, and the Submission
 * was last written after the post began. The caller asks only once the run link
 * and every other field sent match, which is what shows the post itself landed:
 * a PATCH saves all its fields or none, so a field that differs since was changed
 * by a write after it. A record not written since the post began cannot have
 * been, and a post whose start is not known cannot be shown to come before it.
 *
 * Except the inquiry link on a record holding this run's own stamp (#2937).
 * The stamp went in the same update as the link this run sent, so the update
 * landed, and a pipedream.com link there now was written after it whatever
 * LastModifiedDate says. The time test cannot show that when Pipedream's PATCH
 * is the record's last write and lands within the margin: Salesforce keeps
 * whole seconds, so on 2026-10-28 a step begun at 18:42:37.175 read as last
 * modified at 18:42:39.000, which less the margin is before it. A sale's own
 * completion fields keep the time test, stamp or not.
 */
function supersededByLaterWrite(differing: string[], current: Record<string, unknown>, sent: Record<string, unknown>, startedAt: string, ownStamp: boolean): boolean {
  const rules = differing.map((k) => (Object.hasOwn(LATER_WRITE_FIELDS, k) ? LATER_WRITE_FIELDS[k] : null))
  const explained = differing.every((k, i) => {
    const now = current[k]
    if (rules[i] === 'set') return now !== null && now !== undefined && now !== ''
    if (rules[i] === 'later') return salesforceTimeMs(now) > salesforceTimeMs(sent[k])
    if (rules[i] === 'inquiry_link') return isPipedreamLink(now)
    return false
  })
  if (!explained) return false
  if (ownStamp && rules.every((r) => r === 'inquiry_link')) return true
  const started = salesforceTimeMs(startedAt)
  const lastModified = salesforceTimeMs(current.LastModifiedDate)
  // The margin is Salesforce keeping whole seconds on its own clock; here it errs towards "not since".
  return Number.isFinite(started) && Number.isFinite(lastModified) && lastModified - LAST_MODIFIED_MARGIN_MS > started
}

/** A field another Salesforce user changed after this run's write had landed (#3005): who and when, never the value. */
export interface ChangedAfterwards {
  field: string
  byUserId: string
  /** The user's name in Salesforce, when the history answer carried one. */
  byName: string | null
  at: string
}

/** What the Submission's field history says about the fields that differ (#3005). */
type HistoryFinding =
  | { kind: 'explained'; changes: ChangedAfterwards[] }
  | { kind: 'not_explained' }
  | { kind: 'unread'; reason: string; stop: boolean }

/**
 * Whether Salesforce's field history shows every field in `differing` changed by
 * another user after this write landed (#3005), in ONE query of
 * Submission__History since the margin before the write was sent.
 *
 * Asked only when the Submission holds this run's own stamp and link, so the
 * update provably landed, all its fields or none. The rows inside the write's
 * own send span (its step's start to its end, with the margin either side) are
 * this write's, so they must all be one user's, the user that made the write; a
 * second user writing inside the span leaves whose write it was unknown. Then
 * each field needs a row by that user setting it to the value sent, and its
 * LATEST row by another user, in a later second, setting it to what it holds
 * now. A field with no row (Salesforce keeps no history of it), no row by the
 * writing user, or any other shape is not explained, and still did not land.
 * A failed read is `unread`, never explained.
 */
async function changedAfterOwnWrite(read: Read, w: SubmissionWrite, differing: string[], current: Record<string, unknown>): Promise<HistoryFinding> {
  const [span] = w.sentWithin.spans
  if (!w.sentWithin.recorded || !span) return { kind: 'unread', reason: "this run's send time is not recorded, so the history cannot be placed against it", stop: false }
  // Both are checked before any read of the record; nothing else reaches a query.
  if (!isSalesforceRecordId(w.recordId) || !differing.every(isSalesforceApiName)) return { kind: 'not_explained' }
  const fields = differing.map((f) => `'${f}'`).join(',')
  const soql =
    `SELECT Field, NewValue, CreatedById, CreatedBy.Name, CreatedDate FROM Submission__History WHERE ParentId = '${w.recordId}' AND Field IN (${fields}) ` +
    `AND CreatedDate >= ${soqlTime(span.from - LAST_MODIFIED_MARGIN_MS)} ORDER BY CreatedDate, Id LIMIT ${FIELD_HISTORY_ROW_LIMIT}`
  const r = await read(`/query?q=${encodeURIComponent(soql)}`)
  if (r.kind === 'no_answer') return { kind: 'unread', reason: `Salesforce did not answer (${r.error})`, stop: true }
  if (r.status < 200 || r.status >= 300) {
    const code = errorCodeOf(r.text)
    return { kind: 'unread', reason: `Salesforce answered ${r.status}${code ? ` ${code}` : ''}`, stop: r.status === 401 || r.status === 403 }
  }
  const records = queryRecords(r.text)
  if (!records) return { kind: 'unread', reason: "Salesforce's answer was not a complete list", stop: false }
  const rows: Array<{ field: string; value: unknown; by: string; name: string | null; atMs: number }> = []
  for (const row of records) {
    const atMs = salesforceTimeMs(row.CreatedDate)
    const createdBy = asObject(row.CreatedBy)
    if (typeof row.Field !== 'string' || typeof row.CreatedById !== 'string' || !Number.isFinite(atMs)) {
      return { kind: 'unread', reason: 'a field history row had no readable field, user or time', stop: false }
    }
    rows.push({ field: row.Field, value: row.NewValue, by: row.CreatedById, name: typeof createdBy?.Name === 'string' ? createdBy.Name : null, atMs })
  }
  const inSpan = (atMs: number) => atMs >= span.from - LAST_MODIFIED_MARGIN_MS && atMs <= span.to + LAST_MODIFIED_MARGIN_MS
  const writers = new Set(rows.filter((p) => inSpan(p.atMs)).map((p) => p.by))
  if (writers.size !== 1) return { kind: 'not_explained' }
  const [writer] = writers
  const changes: ChangedAfterwards[] = []
  for (const field of differing) {
    const ofField = rows.filter((p) => p.field === field)
    const mine = ofField.find((p) => p.by === writer && inSpan(p.atMs) && sameSalesforceValue(p.value, w.sent[field]))
    const last = ofField[ofField.length - 1]
    if (!mine || !last || last.by === writer || last.atMs <= mine.atMs || !sameSalesforceValue(last.value, current[field])) return { kind: 'not_explained' }
    changes.push({ field, byUserId: last.by, byName: last.name, at: new Date(last.atMs).toISOString() })
  }
  return { kind: 'explained', changes }
}

/** What the Submission's write stamp says, when it is not this run's. */
type StampFinding = { kind: 'none' } | { kind: 'other_run'; run: string; order: 'later' | 'earlier' | 'same_run' | 'unknown' }

/**
 * What a Submission holds that this run did not write, in plain words (#2652):
 * the stamp, the run link and how many fields differ, never which by API name
 * (the record keeps those). A stamp from a run that is known to be later or
 * earlier says what that means for the link and fields in one clause; any other
 * finding is a clause of its own.
 */
function submissionClauses(stamp: StampFinding | null, link: 'none' | 'other' | null, fieldCount: number): string[] {
  if (stamp?.kind === 'other_run' && (stamp.order === 'later' || stamp.order === 'earlier')) {
    const head = stamp.order === 'later' ? 'a later run wrote the same Submission' : "the Submission still holds an earlier run's write"
    const parts = [link ? "this run's link" : null, fieldCount > 0 ? `${fieldCount.toLocaleString('en-US')} of its fields` : null].filter((t): t is string => t !== null)
    if (parts.length === 0) return [head]
    const one = parts.length === 1 && (link !== null || fieldCount === 1)
    return [`${head}, so ${joinAnd(parts)} ${stamp.order === 'later' ? (one ? 'was replaced' : 'were replaced') : 'never arrived'}`]
  }
  const clauses: string[] = []
  if (stamp?.kind === 'none') clauses.push("the Submission does not carry this run's write stamp")
  else if (stamp) clauses.push(stamp.order === 'same_run' ? 'another step of this run wrote the same Submission' : 'another run wrote the same Submission')
  if (link === 'none') clauses.push('the Submission has no Bidspoke run link')
  else if (link === 'other') clauses.push("the Submission's run link is not this run's")
  if (fieldCount === 1) clauses.push('1 of its fields holds a different value from the one this run sent')
  else if (fieldCount > 1) clauses.push(`${fieldCount.toLocaleString('en-US')} of its fields hold different values from the ones this run sent`)
  return clauses
}

/** A reason sentence as a clause inside a longer one. */
const asClause = (sentence: string) => sentence.replace(/\.$/, '')

/** One write's read-back. `stop` says Salesforce stopped answering. */
async function checkWrite(w: SubmissionWrite, read: Read, appUrl: string, earlierRun: EarlierRunLookup, orderOf: SendOrderLookup): Promise<{ verdict: RunVerdict; stop: boolean }> {
  const { executionId, sent, recordId } = w
  const unchecked = (reason: string, stop = false) => ({ verdict: { kind: 'unchecked' as const, executionId, reason }, stop })
  const orderUnknown = (otherExecutionId: string, reason: string) => ({ verdict: { kind: 'order_unknown' as const, executionId, otherExecutionId, reason }, stop: false })
  const superseded = (byExecutionId: string) => ({ verdict: { kind: 'superseded' as const, executionId, byExecutionId }, stop: false })
  const expectedLink = bidspokeRunLink(appUrl, MAIN_FLOW_WORKFLOW_ID, executionId)
  if (!expectedLink) return unchecked('The app address is not set, so the run link cannot be compared.')
  const sentFields = Object.keys(sent).filter((k) => k !== WRITE_MARKER_FIELD && k !== RUN_LINK_FIELD)
  if (!sentFields.every(isSalesforceApiName)) return unchecked('The run sent a key that is not a Salesforce field name, so it was not read back.')
  const stamped = typeof sent[WRITE_MARKER_FIELD] === 'string'
  const sentEngineIds = SUB_UUID in sent && SUB_LEAD_UUID in sent

  const fields = [...new Set([...(stamped ? [WRITE_MARKER_FIELD] : []), RUN_LINK_FIELD, 'Lead__c', 'CreatedDate', 'LastModifiedDate', ...sentFields])]
  const sub = await readRecord(read, 'Submission', `/sobjects/Submission__c/${recordId}?fields=${fields.join(',')}`)
  if (sub.kind === 'unread') return unchecked(sub.reason, sub.stop)
  if (sub.kind === 'missing') return { verdict: { kind: 'not_landed', executionId, problems: ['the Submission does not exist in Salesforce'] }, stop: false }
  const current = sub.body
  const link = current[RUN_LINK_FIELD]

  // A relay post has no stamp to say whose write the record holds, so another
  // run's link whose write was sent later means it was overwritten since, and
  // what the record holds is that run's; one that cannot be ordered against this
  // post is order unknown (#2806). An earlier sent run's link is judged below,
  // as a link that is not this run's. A direct write is set aside only on another
  // run's stamp of the same step, below (#2485); one without its stamp is judged
  // on what it sent.
  if (w.via === 'relay' && !stamped) {
    const other = otherRunInLink(link, expectedLink, executionId)
    if (other) {
      let o: SendOrder
      try {
        o = await orderOf(other, null, w)
      } catch (e) {
        return unchecked(`The send time of the run whose link the Submission holds could not be read (${formatErr(e)}).`)
      }
      if (o.order === 'later') return superseded(other)
      if (o.order === 'unknown') return orderUnknown(other, o.reason)
    }
  }

  let stampFinding: StampFinding | null = null
  // This run's own stamp from a resend: the Salesforce read-back sent the write again (#2938).
  let resent = false
  if (stamped) {
    const stamp = parseWriteMarker(current[WRITE_MARKER_FIELD])
    if (!stamp) stampFinding = { kind: 'none' }
    else if (stamp.executionId === executionId && stamp.stepNamespace === w.stepNamespace) resent = stamp.attempt > ENGINE_ATTEMPT
    else {
      // A customer's later visit writes the same Submission again (#2485). The
      // stamp names that write's run and step, and the run link names its
      // workflow: the same step of a Main Flow run whose write was sent after
      // this one was answered (#2806), whose link the Submission holds,
      // overwrote this write, so what the record holds is that run's and this
      // one is set aside; one that cannot be ordered against it is order
      // unknown. An earlier sent run's stamp, or one that cannot be read, still
      // means this write is not what Salesforce holds. Any other run's stamp is
      // ordered too, only for the words.
      if (stamp.executionId === executionId) {
        stampFinding = { kind: 'other_run', run: stamp.executionId, order: 'same_run' }
      } else {
        const decides = stamp.stepNamespace === w.stepNamespace && otherRunInLink(link, expectedLink, executionId) === stamp.executionId
        let o: SendOrder | null
        try {
          o = await orderOf(stamp.executionId, stamp.stepNamespace, w)
        } catch (e) {
          if (decides) return unchecked(`The send time of the run whose write the Submission holds could not be read (${formatErr(e)}).`)
          o = null
        }
        if (decides && o?.order === 'later') return superseded(stamp.executionId)
        if (decides && o?.order === 'unknown') return orderUnknown(stamp.executionId, o.reason)
        stampFinding = { kind: 'other_run', run: stamp.executionId, order: o && o.order !== 'unknown' ? o.order : 'unknown' }
      }
    }
  }
  const linkFinding = link === null || link === undefined || link === '' ? 'none' : link !== expectedLink ? 'other' : null
  const differing = sentFields.filter((k) => sent[k] !== REDACTED && (!(k in current) || !sameSalesforceValue(current[k], sent[k]))).sort()
  // With no stamp finding, a stamped write's record holds this run's own stamp (#2937).
  const laterWrite = stampFinding === null && linkFinding === null && differing.length > 0 && supersededByLaterWrite(differing, current, sent, w.startedAt, stamped) ? differing : []
  // This run's own stamp and link prove its update landed, so a field that
  // differs was changed since; the field history says by whom (#3005).
  const history = stamped && stampFinding === null && linkFinding === null && differing.length > 0 && laterWrite.length === 0 ? await changedAfterOwnWrite(read, w, differing, current) : null
  const changedAfterwards = history?.kind === 'explained' ? history.changes : []
  const fieldsDiffering = laterWrite.length === 0 && changedAfterwards.length === 0 ? differing : []
  // A history that could not be read clears nothing, and is said.
  const historyClauses = history?.kind === 'unread' ? [`its field history could not be read to see whether another user changed them afterwards (${history.reason})`] : []
  // What the Lead check found, said after what the Submission holds.
  const leadProblems: string[] = []
  const problems = () => [...submissionClauses(stampFinding, linkFinding, fieldsDiffering.length), ...historyClauses, ...leadProblems]
  const verdict = (newerSubmission: boolean, leadFromEarlierRun: string | null = null): RunVerdict =>
    problems().length > 0
      ? {
          kind: 'not_landed',
          executionId,
          problems: problems(),
          ...(fieldsDiffering.length > 0 ? { fields: fieldsDiffering } : {}),
          ...(stampFinding?.kind === 'other_run' ? { stampedBy: stampFinding.run } : {}),
        }
      : laterWrite.length > 0 || changedAfterwards.length > 0 || newerSubmission || leadFromEarlierRun
        ? {
            kind: 'moved_on',
            executionId,
            laterWrite,
            newerSubmission,
            ...(leadFromEarlierRun ? { leadFromEarlierRun } : {}),
            ...(changedAfterwards.length > 0 ? { changedAfterwards } : {}),
            ...(resent ? { resent: true as const } : {}),
          }
        : { kind: 'landed', executionId, ...(resent ? { resent: true as const } : {}) }

  // Salesforce did not answer the history read: the reads stop here, as on any unanswered read.
  if (history?.kind === 'unread' && history.stop) return { verdict: verdict(false), stop: true }

  // The Lead copy is SubmissionService's, of the Engine ids this write sent.
  if (!sentEngineIds) return { verdict: verdict(false), stop: false }
  const leadId = current.Lead__c
  if (typeof leadId !== 'string' || !isSalesforceRecordId(leadId)) {
    leadProblems.push('the Submission has no Lead, so its Engine ids reached no Lead')
    return { verdict: verdict(false), stop: false }
  }
  const lead = await readRecord(read, 'Lead', `/sobjects/Lead/${leadId}?fields=${LEAD_UUID},${LEAD_LEAD_UUID},${LEAD_SUBMISSION}`)
  if (lead.kind === 'unread') {
    if (problems().length === 0) return unchecked(lead.reason, lead.stop)
    leadProblems.push(`its Lead could not be read: ${asClause(lead.reason)}`)
    return { verdict: verdict(false), stop: lead.stop }
  }
  if (lead.kind === 'missing') {
    leadProblems.push('its Lead does not exist in Salesforce')
    return { verdict: verdict(false), stop: false }
  }
  const leadIds = lead.body
  const differsFrom = (sub: Record<string, unknown>) => {
    const which: string[] = []
    if (!sameSalesforceValue(leadIds[LEAD_UUID], sub[SUB_UUID])) which.push('Engine UUID')
    if (!sameSalesforceValue(leadIds[LEAD_LEAD_UUID], sub[SUB_LEAD_UUID])) which.push('Engine Lead UUID')
    return which
  }
  const which = differsFrom(current)
  if (which.length === 0) return { verdict: verdict(false), stop: false }
  const mismatch = which.length === 1 ? `its Lead's ${which[0]} doesn't match the Submission` : "its Lead's Engine ids don't match the Submission"

  const other = leadIds[LEAD_SUBMISSION]
  // SubmissionService copies the Engine ids to the Lead only when the Submission's
  // Completed_Submission_SO__c changes to Yes, and names the Submission on the
  // Lead as it does. A customer's later visit to a Submission an earlier run
  // already completed leaves the Lead alone (#2485). So a Lead naming THIS
  // Submission and holding the ids an earlier run wrote to it holds that first
  // completion's copy. A Lead matching no earlier run's write is a mismatch, and
  // one matching only a run whose write cannot be ordered against this one is
  // order unknown (#2806).
  if (leadNamesSubmission(other, recordId)) {
    let earlier: EarlierRun | null
    try {
      earlier = await earlierRun(w, leadIds)
    } catch (e) {
      const reason = `Main Flow's runs of the day before could not be read to compare the Lead against (${formatErr(e)}).`
      if (problems().length === 0) return unchecked(reason)
      leadProblems.push(mismatch, asClause(reason))
      return { verdict: verdict(false), stop: false }
    }
    if (earlier?.order === 'unknown' && problems().length === 0) return orderUnknown(earlier.run, earlier.reason)
    if (earlier?.order !== 'earlier') leadProblems.push(mismatch)
    return { verdict: verdict(false, earlier?.order === 'earlier' ? earlier.run : null), stop: false }
  }

  // A Lead follows its customer's newest Submission (returning-customer.ts), so a
  // Lead naming a Submission created AFTER this one, whose Engine ids it carries,
  // holds that visit's copy (#2396): this write's ids cannot be on it any more.
  // Any other Lead whose ids differ is a mismatch, as before.
  if (typeof other !== 'string' || !leadNamesAnotherSubmission(other, recordId) || !isSalesforceRecordId(other)) {
    leadProblems.push(mismatch)
    return { verdict: verdict(false), stop: false }
  }
  const newer = await readRecord(read, "Lead's other Submission", `/sobjects/Submission__c/${other}?fields=CreatedDate,${SUB_UUID},${SUB_LEAD_UUID}`)
  if (newer.kind === 'unread') {
    if (problems().length === 0) return unchecked(newer.reason, newer.stop)
    leadProblems.push(mismatch, `the other Submission its Lead names could not be read: ${asClause(newer.reason)}`)
    return { verdict: verdict(false), stop: newer.stop }
  }
  const followedNewer =
    newer.kind === 'record' && salesforceTimeMs(newer.body.CreatedDate) > salesforceTimeMs(current.CreatedDate) && differsFrom(newer.body).length === 0
  if (!followedNewer) leadProblems.push(mismatch)
  return { verdict: verdict(followedNewer), stop: false }
}

/** A sampled relay post whose step failed and recorded nothing it sent (#2939), with the Submission its run's trigger names. */
interface FailedPost {
  executionId: string
  recordId: string
  /** The step timed out at its own deadline, so Pipedream may have taken the post after Bidspoke stopped waiting. */
  timedOut: boolean
  sentWithin: SentWithin
}

/**
 * A failed post's read-back, by its run link alone (#2939): every outcome post
 * sends it, and Salesforce saves one PATCH whole or not at all. This run's link
 * means it arrived. A later run's link, or one that cannot be ordered, is set
 * aside as for any relay post. Otherwise Salesforce holds no sign of it: never
 * sent when the step failed outright, not found when it timed out (L11). A read
 * that fails is could not be checked. `stop` says Salesforce stopped answering.
 */
async function checkFailedPost(p: FailedPost, read: Read, appUrl: string, orderOf: SendOrderLookup): Promise<{ verdict: RelayVerdict; stop: boolean }> {
  const { executionId } = p
  const unchecked = (reason: string, stop = false) => ({ verdict: { kind: 'unchecked' as const, executionId, reason }, stop })
  const noSign = (problems: string[]) => ({ verdict: { kind: p.timedOut ? ('not_found' as const) : ('never_sent' as const), executionId, problems }, stop: false })
  const expectedLink = bidspokeRunLink(appUrl, MAIN_FLOW_WORKFLOW_ID, executionId)
  if (!expectedLink) return unchecked('The app address is not set, so the run link cannot be compared.')
  const sub = await readRecord(read, 'Submission', `/sobjects/Submission__c/${p.recordId}?fields=${RUN_LINK_FIELD},LastModifiedDate`)
  if (sub.kind === 'unread') return unchecked(sub.reason, sub.stop)
  if (sub.kind === 'missing') return noSign(['the Submission does not exist in Salesforce'])
  const link = sub.body[RUN_LINK_FIELD]
  if (link === expectedLink) return { verdict: { kind: 'arrived_unrecorded', executionId }, stop: false }
  const other = otherRunInLink(link, expectedLink, executionId)
  if (other) {
    let o: SendOrder
    try {
      o = await orderOf(other, null, p)
    } catch (e) {
      return unchecked(`The send time of the run whose link the Submission holds could not be read (${formatErr(e)}).`)
    }
    if (o.order === 'later') return { verdict: { kind: 'superseded', executionId, byExecutionId: other }, stop: false }
    if (o.order === 'unknown') return { verdict: { kind: 'order_unknown', executionId, otherExecutionId: other, reason: o.reason }, stop: false }
  }
  return noSign(submissionClauses(null, link === null || link === undefined || link === '' ? 'none' : 'other', 0))
}

/** Reads the window and every native run in it back from Salesforce. Never throws. */
async function measure(subject: CanaryWatchSubject, deps: CanaryWatchDeps, from: string, to: string): Promise<CanaryWatchReport> {
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
  // A sampled subject reads a share spread evenly over the day, as the relay is
  // read (#2174), and the report keeps how many there were in all.
  const sampled = subject.sampleSize === null ? toRead : pickEvenly(toRead, subject.sampleSize)
  if (sampled.length < toRead.length) report.nativeWrites = toRead.length
  // Every write whose step timed out, in the sample or not (#2938): the one most
  // likely to be lost, which a sample reads only by chance. They are already in
  // the day's steps, so no further database read is needed.
  const timedOutSteps = toRead.filter((s) => stepTimeoutMs(s.error_message) !== null)

  const relay = await relayPromise
  const relayWrites: Array<SubmissionWrite | { executionId: string; unchecked: string } | { executionId: string; failed: FailedPost }> = []
  let noSubmission = 0
  if (!('error' in relay)) {
    const parsed = relay.sample.map((s) => ({ s, w: relayWrite(s) }))
    // A failed post recorded no body, so its Submission is the one its run's
    // trigger names (#2939): one database read for the day's few.
    const failedIds = parsed.filter(({ w }) => 'failedUnrecorded' in w).map(({ s }) => s.execution_id)
    let submissions = new Map<string, unknown>()
    let submissionsError: string | null = null
    if (failedIds.length > 0) {
      try {
        submissions = await deps.readRunSubmissions(failedIds, from, to)
      } catch (e) {
        submissionsError = formatErr(e)
      }
    }
    for (const { s, w } of parsed) {
      const executionId = s.execution_id
      if ('noSubmission' in w) noSubmission++
      else if ('unchecked' in w) relayWrites.push({ executionId, unchecked: w.unchecked })
      else if (!('failedUnrecorded' in w)) relayWrites.push(w)
      else if (submissionsError !== null) relayWrites.push({ executionId, unchecked: `The run's Submission could not be read from the database (${submissionsError}).` })
      else if (!submissions.has(executionId)) {
        relayWrites.push({ executionId, unchecked: 'The post recorded nothing it sent, and its run is not in the database to say which Submission it was for.' })
      } else {
        const recordId = submissions.get(executionId)
        // No Submission: the relay's filter stops such a post, so nothing was written.
        if (recordId === null || recordId === undefined || recordId === '') noSubmission++
        else if (typeof recordId !== 'string' || !isSalesforceRecordId(recordId)) relayWrites.push({ executionId, unchecked: "The run's Submission id is not one Salesforce would accept." })
        else relayWrites.push({ executionId, failed: { executionId, recordId, timedOut: stepTimeoutMs(s.error_message) !== null, sentWithin: sentWithin(executionId, [s]) } })
      }
    }
  }

  // One Salesforce, one circuit: the native runs first, then the relay sample.
  let read: Read | null = null
  let stopReason: string | null = null
  if (sampled.length > 0 || relayWrites.length > 0) {
    try {
      read = await deps.salesforce()
    } catch (e) {
      stopReason = `Salesforce settings could not be loaded (${formatErr(e)}).`
    }
  }
  // The day's own direct writes, then the day before's, read once and only when a
  // Lead names a Submission no write of the day explains (#2485).
  const writesOf = (steps: WatchedStep[]) =>
    steps.flatMap((s) => {
      const w = s.step_type === 'salesforce' ? nativeWrite(s, subject.step) : null
      return w && !('unchecked' in w) ? [w] : []
    })
  const today = writesOf([...new Set([...timedOutSteps, ...sampled])])
  let dayBefore: Promise<SubmissionWrite[]> | null = null
  const earlierRun: EarlierRunLookup = async (w, leadIds) => {
    const hit = earlierRunAmong(today, w, leadIds)
    if (hit?.order === 'earlier') return hit
    dayBefore ??= deps.readSteps(new Date(Date.parse(from) - DAY_MS).toISOString(), from).then(writesOf)
    const before = earlierRunAmong(await dayBefore, w, leadIds)
    return before?.order === 'earlier' ? before : (hit ?? before)
  }
  // The send times of the day's own posts, every one of the watched step and
  // the relay sample; any other run's are read once, when a Submission holds
  // its write (#2806).
  const known = new Map<string, SendStep[]>()
  const know = (s: SendStep) => known.set(s.execution_id, [...(known.get(s.execution_id) ?? []), s])
  for (const s of steps) know({ execution_id: s.execution_id, step_namespace: subject.step, started_at: s.started_at, completed_at: s.completed_at, error_message: s.error_message })
  if (!('error' in relay)) {
    for (const s of relay.sample) know({ execution_id: s.execution_id, step_namespace: s.step_namespace, started_at: s.started_at, completed_at: s.completed_at, error_message: s.error_message })
  }
  const fetched = new Map<string, Promise<SendStep[]>>()
  const orderOf: SendOrderLookup = async (other, stepNamespace, w) => {
    const ofStep = (rows: readonly SendStep[]) => rows.filter((r) => stepNamespace === null || r.step_namespace === stepNamespace)
    let rows = ofStep(known.get(other) ?? [])
    if (rows.length === 0) {
      let reading = fetched.get(other)
      if (!reading) {
        reading = deps.readSendSteps(other)
        fetched.set(other, reading)
      }
      rows = ofStep(await reading)
    }
    return sendOrder(sentWithin(other, rows), w.sentWithin)
  }
  /** One read-back under the day's one circuit: none once Salesforce stopped answering, and a throw is could not be checked. */
  const guarded = async <V extends RelayVerdict>(executionId: string, check: (read: Read) => Promise<{ verdict: V; stop: boolean }>): Promise<V | Unchecked> => {
    if (!read || stopReason) return { kind: 'unchecked', executionId, reason: stopReason ?? 'Salesforce stopped answering earlier in this check.' }
    try {
      const { verdict, stop } = await check(read)
      if (stop) stopReason = 'Salesforce stopped answering earlier in this check.'
      return verdict
    } catch (e) {
      return { kind: 'unchecked', executionId, reason: `The check failed on this run (${formatErr(e)}).` }
    }
  }
  const judge = (w: SubmissionWrite): Promise<RunVerdict> => guarded(w.executionId, (r) => checkWrite(w, r, deps.appUrl, earlierRun, orderOf))
  // The timed out writes first, then the sample, under one budget: a slow day
  // spends it on the writes most likely lost. A write in both is read once.
  const directDeadline = subject.readBudgetMs === null ? Number.POSITIVE_INFINITY : deps.now() + subject.readBudgetMs
  const verdictOf = new Map<WatchedStep, RunVerdict>()
  const readDirect = async (s: WatchedStep): Promise<RunVerdict> => {
    const done = verdictOf.get(s)
    if (done) return done
    const w = nativeWrite(s, subject.step)
    const v: RunVerdict =
      'unchecked' in w
        ? { kind: 'unchecked', executionId: s.execution_id, reason: w.unchecked }
        : deps.now() >= directDeadline
          ? { kind: 'unchecked', executionId: s.execution_id, reason: 'The direct reads ran out of time before this write.' }
          : await judge(w)
    verdictOf.set(s, v)
    return v
  }
  const timedOut: RunVerdict[] = []
  for (const s of timedOutSteps) timedOut.push(await readDirect(s))
  const limitsMs = [...new Set(timedOutSteps.flatMap((s) => stepTimeoutMs(s.error_message) ?? []))].sort((a, b) => a - b)
  report.timedOut = { verdicts: timedOut, limitsMs }
  for (const s of sampled) report.native.push(await readDirect(s))

  if ('error' in relay) {
    report.relay = relay
    return report
  }
  const judgeFailed = (p: FailedPost): Promise<RelayVerdict> => guarded(p.executionId, (r) => checkFailedPost(p, r, deps.appUrl, orderOf))
  const sample: RelayVerdict[] = []
  const deadline = deps.now() + RELAY_READ_BUDGET_MS
  for (const w of relayWrites) {
    if ('unchecked' in w) sample.push({ kind: 'unchecked', executionId: w.executionId, reason: w.unchecked })
    else if (deps.now() >= deadline) sample.push({ kind: 'unchecked', executionId: w.executionId, reason: 'The relay reads ran out of time before this post.' })
    else if ('failed' in w) sample.push(await judgeFailed(w.failed))
    else sample.push(await judge(w))
  }
  report.relay = { total: relay.total, sample, noSubmission }
  return report
}

const fmt = (n: number) => n.toLocaleString('en-US')
const runLabel = (appUrl: string, id: string) => {
  const url = bidspokeRunLink(appUrl, MAIN_FLOW_WORKFLOW_ID, id)
  return url ? `<${url}|Run ${id}>` : `Run ${id}`
}

/** A time in ET without its zone, as "Oct 21, 9:23 AM": the sentence says ET once, after the second. */
const etClock = (at: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: ET_ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(at))

const SKIP_WORDS: Record<string, string> = {
  nothing_to_write: 'the Engine sent nothing to write',
  no_record_id: 'there was no Submission to write to',
}

/** Landed fully ("arrived complete"): every field sent was saved, whether or not a later write has moved it on since (#2396). */
const landedFully = (v: RelayVerdict) => v.kind === 'landed' || v.kind === 'moved_on'

/** Did not land fully, or could not be checked: what alerts, and what the record lists by run. */
const isBad = (v: RelayVerdict) => v.kind === 'not_landed' || v.kind === 'unchecked'

const supersededByLater = (vs: readonly RelayVerdict[]) => vs.filter((v) => v.kind === 'moved_on' && v.laterWrite.some((k) => SALE_COMPLETION_FIELDS.has(k))).length
/** Landed, then the inquiry relay's PATCH replaced the link the port adds (2026-10-27). */
const inquiryLinkReplaced = (vs: readonly RelayVerdict[]) => vs.filter((v) => v.kind === 'moved_on' && v.laterWrite.some((k) => LATER_WRITE_FIELDS[k] === 'inquiry_link')).length
/** Landed, then another Salesforce user changed some of its fields, as the field history shows (#3005). */
const changedAfterwardsRuns = (vs: readonly RelayVerdict[]) =>
  vs.filter((v): v is Extract<RunVerdict, { kind: 'moved_on' }> & { changedAfterwards: ChangedAfterwards[] } => v.kind === 'moved_on' && (v.changedAfterwards?.length ?? 0) > 0)
const followedNewerSubmission = (vs: readonly RelayVerdict[]) => vs.filter((v) => v.kind === 'moved_on' && v.newerSubmission).length
const leadFromFirstCompletion = (vs: readonly RelayVerdict[]) => vs.filter((v) => v.kind === 'moved_on' && v.leadFromEarlierRun).length
/** Set aside because a later run wrote the same Submission (#2485). */
const overwritten = (vs: readonly RelayVerdict[]) => vs.filter((v): v is Extract<RunVerdict, { kind: 'superseded' }> => v.kind === 'superseded')

/** Not judged because another run wrote the same Submission and which arrived last cannot be told (#2806). */
const unordered = (vs: readonly RelayVerdict[]) => vs.filter((v): v is Extract<RunVerdict, { kind: 'order_unknown' }> => v.kind === 'order_unknown')

/** At least OVERWRITE_STORM_MIN of the day's direct writes, and OVERWRITE_STORM_SHARE of them. */
const pileOf = (k: number, native: RunVerdict[]) => k >= OVERWRITE_STORM_MIN && k >= OVERWRITE_STORM_SHARE * native.length

/** More direct writes set aside as overwritten than a customer coming back explains (L77). */
const overwriteStorm = (native: RunVerdict[]) => pileOf(overwritten(native).length, native)

/** More direct writes left unordered than near simultaneous visits explain: send times going missing must not go quiet (#2806). */
const unorderedPile = (native: RunVerdict[]) => pileOf(unordered(native).length, native)

/** One write left unordered, in words, with its reason. */
const unorderedLine = (appUrl: string, v: Extract<RunVerdict, { kind: 'order_unknown' }>) =>
  `${runLabel(appUrl, v.executionId)} was not compared: ${runLabel(appUrl, v.otherExecutionId)} also wrote the same Submission, and ${v.reason}, so which arrived last cannot be told.`

/** A run's problem clauses as one sentence: "a, b, and c". */
const sayProblems = (clauses: string[]) =>
  clauses.length <= 1 ? clauses.join('') : `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`

/**
 * Those that arrived complete and were moved on since (#2396, #2485), by which
 * way, so they are counted in the rate and still seen. A post moved on both ways
 * is counted under each. `ofThose` says which runs the first sentence counts
 * from. None of these claims a Lead was compared that was not: a Lead that
 * followed a newer Submission was not compared, and a Lead holding the first
 * completion's copy matched the earlier run, never this one.
 */
function movedOnSentences(vs: readonly RelayVerdict[], ofThose: string): string {
  const a = supersededByLater(vs)
  const b = followedNewerSubmission(vs)
  const c = leadFromFirstCompletion(vs)
  const i = inquiryLinkReplaced(vs)
  const changed = changedAfterwardsRuns(vs)
  const h = changed.length
  const who = joinAnd([...new Set(changed.flatMap((v) => v.changedAfterwards.map((c) => c.byName ?? 'another Salesforce user')))])
  return [
    h > 0
      ? ` ${fmt(h)} ${ofThose} had fields changed afterwards in Salesforce by ${who}. Salesforce's field history shows Bidspoke's values arriving first, so ${h === 1 ? 'the write was' : 'those writes were'} not lost.`
      : '',
    a > 0 ? ` ${fmt(a)} ${ofThose} ${a === 1 ? 'was' : 'were'} updated again later when the sale finished, which is expected.` : '',
    i > 0
      ? ` ${fmt(i)} ${ofThose} had ${i === 1 ? 'its' : 'their'} second Bidspoke link replaced afterwards by a Pipedream link: Pipedream's credit inquiry step still writes that link, and sometimes finishes after the direct write, which is expected until that step moves off Pipedream too.`
      : '',
    b > 0
      ? ` ${fmt(b)} ${b === 1 ? 'belongs to a customer' : 'belong to customers'} who came back and started a new Submission, so only the Submission was checked for ${b === 1 ? 'it' : 'those'}.`
      : '',
    c > 0
      ? c === 1
        ? " 1 went to a Submission an earlier run had already completed. Salesforce copies the Engine ids to the Lead only the first time, so its Lead keeps that earlier run's ids."
        : ` ${fmt(c)} went to Submissions earlier runs had already completed. Salesforce copies the Engine ids to the Lead only the first time, so their Leads keep those earlier runs' ids.`
      : '',
  ].join('')
}

/**
 * The sampled relay posts whose step failed and recorded nothing it sent, by
 * what reading their Submission found (#2939). Never sent is claimed only for a
 * step that failed outright; one that timed out may have reached Pipedream after
 * Bidspoke stopped waiting, so it is said as not found when read (L11).
 */
function failedPostSentences(neverSent: number, notFound: number, arrived: number): string {
  const [ns, nf] = [neverSent === 1, notFound === 1]
  return [
    neverSent > 0
      ? ` ${fmt(neverSent)} of those that did not ${ns ? 'was' : 'were'} never sent: ${ns ? 'its post' : 'their posts'} failed in Bidspoke and recorded nothing ${ns ? 'it' : 'they'} sent, and Salesforce holds no sign of ${ns ? 'it' : 'them'}.`
      : '',
    notFound > 0
      ? ` ${fmt(notFound)} of those that did not timed out in Bidspoke and ${nf ? 'was' : 'were'} not found in Salesforce: Pipedream may have taken ${nf ? 'it' : 'them'} after Bidspoke stopped waiting, but Salesforce held no sign of ${nf ? 'it' : 'them'} when read.`
      : '',
    arrived === 1
      ? ' The one that arrived though its post failed has its run link on its Submission, but its post recorded nothing it sent, so its fields were not compared.'
      : arrived > 1
        ? ` The ${fmt(arrived)} that arrived though their posts failed have their run links on their Submissions, but their posts recorded nothing they sent, so their fields were not compared.`
        : '',
  ].join('')
}

/**
 * The Pipedream comparison, on the direct writes' own measure: of the outcomes
 * read back, how many Salesforce took in full (#2313), those moved on since among
 * them and said (#2396). Outcomes a later run overwrote, and those with no
 * Submission, are said and left out of the count. The direct count is not
 * repeated here: its own paragraph says it (#2652). A post whose step failed
 * and that Salesforce holds no sign of counts as did not, against Pipedream,
 * and is said as never sent or not found (#2939).
 */
function relayLine(r: RelayReadBack): string {
  const count = (k: RelayVerdict['kind']) => r.sample.filter((v) => v.kind === k).length
  const landed = r.sample.filter(landedFully).length
  const [notLanded, neverSent, notFound, arrived] = [count('not_landed'), count('never_sent'), count('not_found'), count('arrived_unrecorded')]
  const didNot = notLanded + neverSent + notFound
  const unchecked = count('unchecked')
  const superseded = count('superseded')
  const orderUnknown = count('order_unknown')
  const judged = landed + arrived + didNot + unchecked
  let line: string
  if (judged === 0) {
    line = `In the same hours Pipedream sent ${fmt(r.total)} other outcome${r.total === 1 ? '' : 's'}.`
    if (superseded + orderUnknown + r.noSubmission === 0) line += ' None of them were checked in Salesforce.'
  } else {
    const allComplete = didNot + unchecked + arrived === 0
    const checked = judged === r.total ? (judged === 1 ? 'the one outcome' : `all ${fmt(judged)} outcomes`) : `${fmt(judged)} of the ${fmt(r.total)} outcomes`
    const result = allComplete
      ? `, and ${judged === 1 ? 'it' : `all ${fmt(judged)}`} arrived complete.`
      : `: ${joinAnd([
          `${fmt(landed)} arrived complete`,
          ...(arrived > 0 ? [`${fmt(arrived)} arrived though Bidspoke recorded ${arrived === 1 ? 'its post' : 'their posts'} as failed`] : []),
          ...(didNot > 0 ? [`${fmt(didNot)} did not`] : []),
          ...(unchecked > 0 ? [`${fmt(unchecked)} could not be checked`] : []),
        ])}.`
    line =
      `For comparison, we checked ${checked} Pipedream sent in the same hours${result}` +
      failedPostSentences(neverSent, notFound, arrived) +
      movedOnSentences(r.sample, allComplete ? 'of those' : 'of those that arrived complete')
  }
  const more = judged > 0 ? 'more' : 'of them'
  if (superseded > 0) line += ` ${fmt(superseded)} ${more} ${superseded === 1 ? 'was' : 'were'} left out because a later run of Main Flow wrote the same Submission.`
  if (orderUnknown > 0) {
    line += ` ${fmt(orderUnknown)} ${more} ${orderUnknown === 1 ? 'was' : 'were'} left out because another run of Main Flow wrote the same Submission and which arrived last cannot be told.`
  }
  if (r.noSubmission > 0) line += ` ${fmt(r.noSubmission)} ${more} had no Submission, so Pipedream wrote nothing.`
  return line
}

/**
 * The direct writes' own paragraph: how many leads were written directly over
 * the hours read, and how many arrived complete. "Arrived complete" is said once,
 * with what it means, and only on a day nothing went wrong. A sampled day says
 * how many were written and how many of them were checked (#2174). The Lead is
 * claimed only for a subject whose body sends the Engine ids.
 */
function directLine(native: RunVerdict[], span: string, subject: CanaryWatchSubject, written: number): string {
  const n = native.length
  const landed = native.filter(landedFully).length
  const notLanded = native.filter((v) => v.kind === 'not_landed').length
  const unchecked = native.filter((v) => v.kind === 'unchecked').length
  const k = overwritten(native).length
  const u = unordered(native).length
  const unorderedSentence = (more: boolean) =>
    ` ${fmt(u)}${more ? ' more' : ''} ${u === 1 ? 'was' : 'were'} not compared: another run also wrote the same Submission, and which of the two arrived last cannot be told.`
  let line =
    written > n
      ? `From ${span}, ${fmt(written)} leads were written directly. We checked ${fmt(n)} of them, spread over those hours`
      : `From ${span}, ${fmt(n)} ${n === 1 ? 'lead was' : 'leads were'} written directly`
  if (landed === n) line += n === 1 ? ', and it arrived complete.' : `, and all ${fmt(n)} arrived complete.`
  else if (k === n) {
    line += `, and ${n === 1 ? 'it was' : `all ${fmt(n)} were`} replaced by a later run that wrote the same Submission, so ${n === 1 ? 'it was' : 'they were'} not compared.`
    return line
  } else if (k + u === n) {
    line += '.'
    if (k > 0) line += ` ${fmt(k)} ${k === 1 ? 'was' : 'were'} replaced by a later run that wrote the same Submission, so ${k === 1 ? 'it was' : 'they were'} not compared.`
    return line + unorderedSentence(k > 0)
  } else {
    line += `. ${joinAnd([`${fmt(landed)} arrived complete`, ...(notLanded > 0 ? [`${fmt(notLanded)} did not`] : []), ...(unchecked > 0 ? [`${fmt(unchecked)} could not be checked`] : [])])}.`
  }
  if (landed > 0 && notLanded + unchecked === 0) {
    // A Lead that followed a newer Submission, or holds the first completion's copy, was not compared with this run's ids.
    const compared = followedNewerSubmission(native) + leadFromFirstCompletion(native) > 0 ? ' we compared' : ''
    const lead = subject.checksLead ? (landed === 1 ? `, and the Lead${compared} has matching Engine ids` : `, and each Lead${compared} has matching Engine ids`) : ''
    // A field another user changed since is no longer held, only received (#3005).
    const has = changedAfterwardsRuns(native).length > 0 ? 'received' : 'has'
    line += landed === 1 ? ` The Submission ${has} every field the run sent${lead}.` : ` Each Submission ${has} every field the run sent${lead}.`
  }
  line += movedOnSentences(native, notLanded + unchecked + k + u === 0 ? 'of those' : 'of those that arrived complete')
  if (k > 0) line += ` ${fmt(k)} more ${k === 1 ? 'was' : 'were'} replaced by a later run that wrote the same Submission, so ${k === 1 ? 'it was' : 'they were'} not compared.`
  if (u > 0) line += unorderedSentence(true)
  return line
}

/** A step deadline in seconds, as "5.25 s". */
const seconds = (ms: number) => `${(ms / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })} s`

/** "a", "a or b", "a, b or c". */
const joinOr = (items: string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`)

/**
 * The timed out writes' own sentence (#2938): how many of the day's direct
 * writes timed out, at what limit, and what reading each one back found. Every
 * one is read, sampled or not, so its counts are of all of them. "Arrived
 * complete" is read back and matched; one whose read failed could not be
 * checked, never lost (L11); one the read-back had to send again is said so.
 * A day none timed out says that too, so a quiet line means none, not unread.
 */
function timedOutLine(t: TimedOutReadBack, written: number): string {
  const vs = t.verdicts
  const k = vs.length
  if (k === 0) return written === 1 ? 'It did not time out waiting for Salesforce.' : `None of the ${fmt(written)} timed out waiting for Salesforce.`
  const head = k === written ? (k === 1 ? 'It timed out' : `All ${fmt(k)} timed out`) : `${fmt(k)} of the ${fmt(written)} timed out`
  const said = `${head} after ${joinOr(t.limitsMs.map(seconds))} without an answer from Salesforce.`
  const landed = vs.filter(landedFully)
  const resent = landed.filter((v) => v.resent).length
  const them = resent === 1 ? 'it' : 'them'
  const count = (kind: RunVerdict['kind']) => vs.filter((v) => v.kind === kind).length
  if (k === 1) {
    const [v] = vs
    const outcome =
      v.kind === 'landed' || v.kind === 'moved_on'
        ? resent > 0
          ? 'It arrived complete, but only after Bidspoke sent it again.'
          : 'It arrived complete.'
        : v.kind === 'not_landed'
          ? 'It did not arrive complete.'
          : v.kind === 'unchecked'
            ? 'It could not be checked.'
            : v.kind === 'superseded'
              ? 'A later run wrote the same Submission, so it was not compared.'
              : 'Another run wrote the same Submission and which arrived last cannot be told, so it was not compared.'
    return `${said} ${outcome}`
  }
  if (landed.length === k) {
    return `${said} All ${fmt(k)} were checked, and all ${fmt(k)} arrived complete${resent > 0 ? `, ${fmt(resent)} of them only after Bidspoke sent ${them} again` : ''}.`
  }
  const [notLanded, unchecked, superseded, unorderedN] = [count('not_landed'), count('unchecked'), count('superseded'), count('order_unknown')]
  const parts = [
    landed.length > 0 ? `${fmt(landed.length)} arrived complete${resent > 0 ? ` (${fmt(resent)} only after Bidspoke sent ${them} again)` : ''}` : null,
    notLanded > 0 ? `${fmt(notLanded)} did not arrive complete` : null,
    unchecked > 0 ? `${fmt(unchecked)} could not be checked` : null,
    superseded > 0 ? `${fmt(superseded)} ${superseded === 1 ? 'was' : 'were'} replaced by a later run that wrote the same Submission` : null,
    unorderedN > 0 ? `${fmt(unorderedN)} ${unorderedN === 1 ? 'was' : 'were'} not compared, as another run wrote the same Submission and which arrived last cannot be told` : null,
  ].filter((p): p is string => p !== null)
  return `${said} Of those ${fmt(k)}, ${joinAnd(parts)}.`
}

/** The Fix line for a pile of writes left unordered (#2806): no write was shown lost, so it never says move back to Pipedream. */
const UNORDERED_FIX =
  "More writes than usual could not be ordered against another run that wrote the same Submission. Open the runs above: a send time that is not recorded means Main Flow's step records are missing; writes sent at nearly the same time are usually one visit sent twice."

/** The Fix line for an overwrite storm (#2485): no write was shown lost, so it never says move back to Pipedream. */
const OVERWRITE_FIX =
  'More runs than usual wrote a Submission that a later run wrote again. Open the runs above: one customer coming back several times is expected, the same visit written twice is not.'

/** The Fix line for a day Main Flow spent off the direct write (#2312). */
const ROLLBACK_FIX =
  "If Main Flow was moved back to Pipedream on purpose, nothing else is needed. If not, open Main Flow's version history and see which version is live. Either way, the time on Pipedream is a gap in the direct writes being measured."

/**
 * The day's message, separate from the send so the words can be tested. One
 * vocabulary on every variant (#2652): "written directly" for the native write,
 * "Pipedream" for the relay, "arrived complete" for landed fully, no field API
 * names, times in ET.
 */
export function canaryWatchMessage(report: CanaryWatchReport, appUrl: string, subject: CanaryWatchSubject = INVALID_STATE_SUBJECT): CanaryWatchMessage {
  const TITLE = subject.title
  if (report.readError) {
    return {
      title: `${TITLE}: the check could not run`,
      lines: [`The check could not read yesterday's Main Flow runs from the database (${report.readError}).`],
      fixHint: 'Check the database is answering. The check runs again tomorrow morning.',
      alert: true,
    }
  }
  const span = `${etClock(report.from)} to ${etClock(report.to)} ET`
  const n = report.native.length
  const landed = report.native.filter(landedFully).length
  const notLanded = report.native.filter((v) => v.kind === 'not_landed').length
  const unchecked = report.native.filter((v) => v.kind === 'unchecked').length
  const setAside = overwritten(report.native)
  const storm = overwriteStorm(report.native)
  const notOrdered = unordered(report.native)
  const pile = unorderedPile(report.native)
  const written = report.nativeWrites ?? n
  // A sampled day's counts are of the writes checked, and its title says so.
  const ofN = written > n ? `${fmt(n)} checked` : fmt(n)
  const lines: string[] = [subject.intro]

  lines.push(n === 0 ? `No leads were written directly from ${span}.` : directLine(report.native, span, subject, written))
  if (n > 0 && report.timedOut) lines.push(timedOutLine(report.timedOut, written))
  if (report.skipped.length > 0) {
    const k = report.skipped.length
    const reasons = joinAnd([...new Set(report.skipped.map((s) => SKIP_WORDS[s.reason] ?? `the step said ${s.reason}`))])
    lines.push(`${fmt(k)} more ${k === 1 ? 'lead was' : 'leads were'} not written because ${reasons}.`)
  }
  const r = report.relayInvalidState
  const outcomes = (k: number) => `${fmt(k)} ${k === 1 ? subject.outcome.one : subject.outcome.many}`
  const offDirect = report.lastWasRelay || report.relayAfterSwitch > 0
  // Every direct post is either read back (native) or skipped, so neither means none went direct.
  const neverDirect = r > 0 && report.native.length === 0 && report.skipped.length === 0
  if (neverDirect) {
    lines.push(
      r === 1
        ? `The one ${subject.outcome.one} went through Pipedream, so Main Flow is not writing these directly.`
        : `All ${outcomes(r)} went through Pipedream, so Main Flow is not writing them directly.`,
    )
  } else if (report.lastWasRelay) {
    lines.push(
      r === 1
        ? `${outcomes(r)} went through Pipedream after every direct write, so Main Flow is back on Pipedream.`
        : `${outcomes(r)} went through Pipedream, the last of them after every direct write, so Main Flow is back on Pipedream.`,
    )
  } else {
    const before = r - report.relayAfterSwitch
    if (before > 0) lines.push(`${outcomes(before)} went through Pipedream before Main Flow started writing them directly.`)
    if (report.relayAfterSwitch > 0) {
      lines.push(`${outcomes(report.relayAfterSwitch)} went through Pipedream between direct writes, so Main Flow went back to Pipedream for a while and came back.`)
    }
  }

  // A timed out write that did not arrive, or could not be checked, is named as
  // timed out, first, and once even when the sample holds it too (#2938).
  const timedOut = report.timedOut?.verdicts ?? []
  const timedOutIds = new Set(timedOut.map((v) => v.executionId))
  const bad = [...timedOut.filter(isBad), ...report.native.filter(isBad).filter((v) => !timedOutIds.has(v.executionId))]
  for (const v of bad.slice(0, MAX_LISTED_RUNS)) {
    const label = runLabel(appUrl, v.executionId)
    const late = timedOutIds.has(v.executionId)
    if (v.kind === 'not_landed') lines.push(late ? `${label} timed out and did not arrive complete: ${sayProblems(v.problems)}.` : `${label}: ${sayProblems(v.problems)}.`)
    else lines.push(`${label}${late ? ' timed out and' : ''} could not be checked: ${v.reason}`)
  }
  if (bad.length > MAX_LISTED_RUNS) {
    lines.push(`${fmt(bad.length - MAX_LISTED_RUNS)} more runs did not arrive complete or could not be checked; the job run record lists them all.`)
  }
  if (storm) {
    for (const v of setAside.slice(0, MAX_LISTED_RUNS)) {
      lines.push(`${runLabel(appUrl, v.executionId)} was replaced by ${runLabel(appUrl, v.byExecutionId)}, a later run that wrote the same Submission.`)
    }
    if (setAside.length > MAX_LISTED_RUNS) lines.push(`${fmt(setAside.length - MAX_LISTED_RUNS)} more runs were replaced; the job run record lists them all.`)
  }
  // Each write left unordered is named with its reason, every day (#2806, L540).
  for (const v of notOrdered.slice(0, MAX_LISTED_RUNS)) lines.push(unorderedLine(appUrl, v))
  if (notOrdered.length > MAX_LISTED_RUNS) lines.push(`${fmt(notOrdered.length - MAX_LISTED_RUNS)} more runs were not compared; the job run record lists them all.`)

  if ('error' in report.relay) {
    lines.push(`Pipedream's outcomes could not be read from the database (${report.relay.error}).`)
  } else if (report.relay.total === 0) {
    lines.push('No other outcome went through Pipedream in those hours, so there is nothing to compare against.')
  } else {
    lines.push(relayLine(report.relay))
  }

  const alert = bad.length > 0 || offDirect || storm || pile
  const t = timedOut.length
  const timedOutNotLanded = timedOut.filter((v) => v.kind === 'not_landed').length
  const timedOutUnchecked = timedOut.filter((v) => v.kind === 'unchecked').length
  const theTimedOut = (k: number) => (t === 1 ? 'the one write that timed out' : `${fmt(k)} of the ${fmt(t)} writes that timed out`)
  let title: string
  // A timed out write that did not arrive leads the title, never folded into the sample's count (#2938).
  if (timedOutNotLanded > 0) {
    const others = report.native.filter((v) => v.kind === 'not_landed' && !timedOutIds.has(v.executionId)).length
    title = `${TITLE}: ${theTimedOut(timedOutNotLanded)} did not arrive complete${others > 0 ? `, and ${fmt(others)} more of ${ofN} did not` : ''}`
  } else if (notLanded > 0 && unchecked > 0) title = `${TITLE}: ${fmt(notLanded)} of ${ofN} did not arrive complete, and ${fmt(unchecked)} could not be checked`
  else if (notLanded > 0) title = `${TITLE}: ${fmt(notLanded)} of ${ofN} did not arrive complete`
  else if (unchecked > 0) title = `${TITLE}: ${fmt(unchecked)} of ${ofN} could not be checked`
  else if (timedOutUnchecked > 0) title = `${TITLE}: ${theTimedOut(timedOutUnchecked)} could not be checked`
  // Not "back on": when nothing in the window went direct, the window cannot show it ever left.
  else if (neverDirect) title = `${TITLE}: Main Flow is not writing directly`
  else if (report.lastWasRelay) title = `${TITLE}: Main Flow is back on Pipedream`
  else if (offDirect) title = `${TITLE}: Main Flow went back to Pipedream for a while`
  else if (storm) title = `${TITLE}: ${fmt(setAside.length)} of ${ofN} were replaced by a later run`
  else if (pile) title = `${TITLE}: ${fmt(notOrdered.length)} of ${ofN} were not compared`
  else if (n === 0) title = `${TITLE}: none to check yesterday`
  else if (setAside.length + notOrdered.length > 0) {
    const [k, u] = [setAside.length, notOrdered.length]
    const what = [k > 0 ? `${fmt(k)} ${k === 1 ? 'was' : 'were'} replaced by a later run` : null, u > 0 ? `${fmt(u)} ${u === 1 ? 'was' : 'were'} not compared` : null].filter((t): t is string => t !== null)
    title =
      n === 1
        ? `${TITLE}: the one write ${k === 1 ? 'was replaced by a later run' : 'was not compared'}`
        : `${TITLE}: ${fmt(landed)} of ${ofN} arrived complete and ${joinAnd(what)}`
  } else title = n === 1 ? `${TITLE}: the one write arrived complete` : `${TITLE}: all ${ofN} arrived complete`

  return {
    title,
    lines,
    ...(alert
      ? {
          fixHint: [
            notLanded + timedOutNotLanded > 0
              ? 'Open each run above and its Submission in Salesforce. If writes are being lost, move Main Flow back to Pipedream with the saved rollback record.'
              : unchecked + timedOutUnchecked > 0
                ? 'Check Salesforce is answering and its login works. The check runs again tomorrow morning; check these runs by hand meanwhile.'
                : null,
            offDirect ? ROLLBACK_FIX : null,
            storm ? OVERWRITE_FIX : null,
            pile ? UNORDERED_FIX : null,
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

/** The timed out writes in the job run record (#2938): counts, and the runs that did not arrive or could not be checked, by id, never a value. */
function timedOutSummary(t: TimedOutReadBack | undefined): Record<string, unknown> {
  if (!t) return {}
  const vs = t.verdicts
  return {
    timed_out: vs.length,
    timed_out_limits_ms: t.limitsMs,
    timed_out_landed: vs.filter(landedFully).length,
    // Of those, the ones that arrived only when the read-back sent them again.
    timed_out_resent: vs.filter(landedFully).filter((v) => v.resent).length,
    timed_out_not_landed: vs.filter((v) => v.kind === 'not_landed').length,
    timed_out_unchecked: vs.filter((v) => v.kind === 'unchecked').length,
    timed_out_superseded: vs.filter((v) => v.kind === 'superseded').length,
    timed_out_order_unknown: vs.filter((v) => v.kind === 'order_unknown').length,
    timed_out_runs: vs.filter(isBad),
  }
}

function endingOf(report: CanaryWatchReport, posted: boolean, subject: CanaryWatchSubject): JobRunEnding {
  const count = (k: RunVerdict['kind']) => report.native.filter((v) => v.kind === k).length
  if (report.notSwitchedOn) {
    return {
      outcome: 'not_switched_on',
      detail: `Main Flow does not hold the ${subject.step} port and none of its posts went direct, so nothing was read or posted`,
      summary: { step: subject.step, from: report.from, to: report.to },
    }
  }
  return {
    outcome: !posted
      ? 'not_posted'
      : report.readError
        ? 'read_failed'
        : report.native.some(isBad) || (report.timedOut?.verdicts.some(isBad) ?? false)
          ? 'not_all_landed'
          : report.lastWasRelay || report.relayAfterSwitch > 0
            ? 'off_direct_write'
            : overwriteStorm(report.native)
              ? 'overwrite_storm'
              : unorderedPile(report.native)
                ? 'order_unknown_pile'
                : report.native.length === 0
                ? 'no_runs'
                : 'all_landed',
    detail: report.readError ?? `${report.native.length} runs read back`,
    summary: {
      step: subject.step,
      from: report.from,
      to: report.to,
      // Every native write, and of them the ones read back (all, unless the subject samples, #2174).
      native_writes: report.nativeWrites ?? report.native.length,
      native: report.native.length,
      // Landed fully, those a later write or a newer Submission moved on since among them (#2396).
      landed: report.native.filter(landedFully).length,
      not_landed: count('not_landed'),
      unchecked: count('unchecked'),
      superseded_by_later_write: supersededByLater(report.native),
      // Landed, then the inquiry relay's PATCH replaced the PDFlow_4__c link (2026-10-27).
      inquiry_link_replaced: inquiryLinkReplaced(report.native),
      // Landed, then another Salesforce user changed some of its fields, per the field history (#3005); the runs are in moved_on_runs.
      changed_afterwards: changedAfterwardsRuns(report.native).length,
      followed_newer_submission: followedNewerSubmission(report.native),
      // Overwritten by a later RUN's write to the same Submission (#2485), not judged; and the runs, by id.
      superseded: overwritten(report.native).length,
      superseded_runs: overwritten(report.native),
      // Another run wrote the same Submission and which arrived last cannot be told (#2806), not judged; the runs, by id, with why.
      order_unknown: unordered(report.native).length,
      order_unknown_runs: unordered(report.native),
      // Landed, with a Lead holding an earlier run's Engine ids from the Submission's first completion (#2485).
      lead_from_first_completion: leadFromFirstCompletion(report.native),
      // Every write whose step timed out, read back sampled or not (#2938), and the deadlines they timed out at.
      ...timedOutSummary(report.timedOut),
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
              landed: report.relay.sample.filter(landedFully).length,
              not_landed: report.relay.sample.filter((v) => v.kind === 'not_landed').length,
              // Posts whose step failed and recorded nothing it sent (#2939): no sign in Salesforce,
              // by a step that failed outright or one that timed out, and those whose run link arrived.
              never_sent: report.relay.sample.filter((v) => v.kind === 'never_sent').length,
              not_found: report.relay.sample.filter((v) => v.kind === 'not_found').length,
              arrived_unrecorded: report.relay.sample.filter((v) => v.kind === 'arrived_unrecorded').length,
              unchecked: report.relay.sample.filter((v) => v.kind === 'unchecked').length,
              // Overwritten by a later RUN, so left out of the rate; not the two below.
              superseded: report.relay.sample.filter((v) => v.kind === 'superseded').length,
              // Not ordered against another run's write (#2806), so left out of the rate too; the runs, with why.
              order_unknown: unordered(report.relay.sample).length,
              order_unknown_runs: unordered(report.relay.sample),
              superseded_by_later_write: supersededByLater(report.relay.sample),
              followed_newer_submission: followedNewerSubmission(report.relay.sample),
              // Run ids and what was wrong, never a value, the posts not in Salesforce among them (#2939).
              runs: report.relay.sample.filter((v) => isBad(v) || v.kind === 'never_sent' || v.kind === 'not_found'),
              // Run ids and the field names a later write changed, never a value.
              moved_on_runs: report.relay.sample.filter((v) => v.kind === 'moved_on'),
            },
      // Run ids and what was wrong, never a value: the record behind the message's "and N more".
      runs: report.native.filter(isBad),
      // Run ids and the field names a later write changed, never a value (#2396).
      moved_on_runs: report.native.filter((v) => v.kind === 'moved_on'),
    },
  }
}

/**
 * Whether the day is to be read at all (#2174): yes when the live Main Flow
 * holds the subject's port, or when any of its posts went direct in the window
 * (the port undone since is a rollback the message must say, #2312), or when
 * this check has ever posted a day (so a canary rolled back is said every day,
 * never silenced). Only a subject never switched on stays quiet. A read that
 * fails counts as yes, so a day is reported rather than silenced. Never throws.
 */
async function switchedOn(subject: CanaryWatchSubject, deps: CanaryWatchDeps, from: string, to: string): Promise<boolean> {
  const asks: Array<[string, (() => Promise<boolean>) | undefined]> = [
    ['whether Main Flow holds the port', deps.livePorted],
    ['whether any post went direct', deps.anyDirect && (() => deps.anyDirect!(from, to))],
    ['whether this check has posted a day before', deps.reportedBefore],
  ]
  for (const [what, ask] of asks) {
    if (!ask) return true
    try {
      if (await ask()) return true
    } catch (e) {
      console.error(`[${subject.job}] could not read ${what}, so the day is read:`, formatErr(e))
      return true
    }
  }
  return false
}

/** One subject's day, end to end. NEVER THROWS: its caller is a waitUntil, where a rejection reaches nobody (L71). */
export async function runCanaryWatch(subject: CanaryWatchSubject, deps: CanaryWatchDeps): Promise<CanaryWatchReport> {
  const startedAtMs = deps.now()
  const { from, to } = canaryWatchWindow(startedAtMs)
  let report: CanaryWatchReport
  let posted = false
  if (!(await switchedOn(subject, deps, from, to))) {
    report = { from, to, native: [], skipped: [], relayInvalidState: 0, relayAfterSwitch: 0, lastWasRelay: false, nativeCompleted: 0, relay: { total: 0, sample: [], noSubmission: 0 }, notSwitchedOn: true }
    console.log(`[${subject.job}] from=${from} to=${to} not switched on: Main Flow does not hold the ${subject.step} port and none of its posts went direct`)
  } else {
    report = await measure(subject, deps, from, to)
    try {
      posted = await deps.post(canaryWatchMessage(report, deps.appUrl, subject), subject.alertKind)
      if (!posted) console.error(`[${subject.job}] Slack did not take the daily message`)
    } catch (e) {
      console.error(`[${subject.job}] could not post the daily message:`, formatErr(e))
    }
    const landed = report.native.filter(landedFully).length
    const movedOn = report.native.filter((v) => v.kind === 'moved_on').length
    console.log(
      `[${subject.job}] from=${from} to=${to} native_writes=${report.nativeWrites ?? report.native.length} native=${report.native.length} landed=${landed} moved_on=${movedOn} order_unknown=${unordered(report.native).length} skipped=${report.skipped.length} ` +
        `timed_out=${report.timedOut?.verdicts.length ?? 0} timed_out_landed=${report.timedOut?.verdicts.filter(landedFully).length ?? 0} ` +
        `relay_watched_step=${report.relayInvalidState} relay_after_switch=${report.relayAfterSwitch} last_was_relay=${report.lastWasRelay} posted=${posted}${report.readError ? ` read_error=${report.readError}` : ''}`,
    )
  }
  try {
    await deps.recordRun?.(startedAtMs, endingOf(report, posted, subject))
  } catch (e) {
    console.error(`[${subject.job}] could not record its run:`, formatErr(e))
  }
  return report
}

/** The invalid state canary's day (#2173). */
export const runInvalidStateWatch = (deps: CanaryWatchDeps): Promise<CanaryWatchReport> => runCanaryWatch(INVALID_STATE_SUBJECT, deps)

/** The filter methods the relay filter calls, which every supabase-js filter builder has, each returning the builder. */
interface RelayFilterable {
  eq(column: string, value: string): RelayFilterable
  in(column: string, values: string[]): RelayFilterable
  gte(column: string, value: string): RelayFilterable
  lt(column: string, value: string): RelayFilterable
  not(column: string, operator: string, value: boolean): RelayFilterable
}

/**
 * The relay comparison's posts in [from, to): every post's id, in time order, a
 * page at a time (PostgREST answers at most 1,000 rows), then the full rows of a
 * RELAY_SAMPLE_SIZE sample spread evenly over them, in that order. A day past
 * MAX_RELAY_POSTS throws rather than sampling part of it, and so does a sample
 * read that comes back short. Throws on a failed read.
 */
export async function readRelayPosts(supabase: SupabaseClient, from: string, to: string): Promise<{ total: number; sample: RelayStep[] }> {
  // The relay filter, applied to each read below; each read declares its own
  // bound after it (#1437): the id list pages with a full order, the sample is
  // one .limit() of the ids it picked.
  const onlyRelayPosts = <Q extends { eq: unknown }>(query: Q): Q =>
    (query as unknown as RelayFilterable)
      .eq('workflow_id', MAIN_FLOW_WORKFLOW_ID)
      .in('step_namespace', [...RELAY_COMPARISON_POSTS])
      .eq('step_type', 'webhook')
      .gte('execution_started_at', from)
      .lt('execution_started_at', to)
      .not('is_test', 'is', true) as unknown as Q
  const ids = (
    await fetchAllPaged<{ id: string }>(
      (lo, hi) =>
        onlyRelayPosts(supabase.from('execution_steps').select('id'))
          .order('execution_started_at', { ascending: true })
          .order('id', { ascending: true })
          .range(lo, hi),
      'relay post list',
      { maxPages: Math.ceil(MAX_RELAY_POSTS / PAGE_SIZE) },
    )
  ).map((r) => r.id)
  const picked = pickEvenly(ids, RELAY_SAMPLE_SIZE)
  if (picked.length === 0) return { total: 0, sample: [] }
  const { data, error } = await onlyRelayPosts(supabase.from('execution_steps').select(`id, step_namespace, ${STEP_COLUMNS}`))
    .in('id', picked)
    .limit(RELAY_SAMPLE_SIZE)
  if (error) throw new Error(`relay sample read failed: ${error.message}`)
  const byId = new Map(((data ?? []) as unknown as Array<RelayStep & { id: string }>).map((r) => [r.id, r]))
  const sample = picked.map((id) => byId.get(id)).filter((r): r is RelayStep & { id: string } => r !== undefined)
  if (sample.length !== picked.length) throw new Error(`the relay sample read returned ${sample.length} of ${picked.length} posts`)
  return { total: ids.length, sample }
}

/**
 * Every step of `step` in [from, to), test runs left out, oldest run first, a
 * page at a time under a full order (PostgREST answers at most 1,000 rows). A
 * day past `maxSteps` throws rather than reading part of it. Throws on a failed
 * read.
 */
export async function readWatchedSteps(supabase: SupabaseClient, step: string, from: string, to: string, maxSteps: number): Promise<WatchedStep[]> {
  return fetchAllPaged<WatchedStep>(
    (lo, hi) =>
      supabase
        .from('execution_steps')
        .select(`id, ${STEP_COLUMNS}`)
        .eq('workflow_id', MAIN_FLOW_WORKFLOW_ID)
        .eq('step_namespace', step)
        .gte('execution_started_at', from)
        .lt('execution_started_at', to)
        .not('is_test', 'is', true)
        .order('execution_started_at', { ascending: true })
        .order('id', { ascending: true })
        .range(lo, hi),
    `${step} steps`,
    { maxPages: Math.ceil(maxSteps / PAGE_SIZE) },
  )
}

/**
 * One Main Flow run's outcome post steps with their send and answer times
 * (#2806). execution_steps is partitioned by the step's start, so the read is
 * bounded by the run's own start (its UUIDv7): from SEND_READ_MARGIN_MS before
 * it to SEND_BOUND_MS after, the span its posts are sent in. An id that is not a
 * UUIDv7 has no start, so nothing is read for it. Throws on a failed read.
 */
export async function readSendSteps(supabase: SupabaseClient, executionId: string): Promise<SendStep[]> {
  const minted = mintedMsFromUuidV7(executionId)
  if (minted === null) return []
  const { data, error } = await supabase
    .from('execution_steps')
    .select('execution_id, step_namespace, started_at, completed_at, error_message')
    .eq('workflow_id', MAIN_FLOW_WORKFLOW_ID)
    .eq('execution_id', executionId)
    .in('step_namespace', [...OUTCOME_POSTS])
    .gte('started_at', new Date(minted - SEND_READ_MARGIN_MS).toISOString())
    .lt('started_at', new Date(minted + SEND_BOUND_MS).toISOString())
    .limit(SEND_READ_LIMIT)
  if (error) throw new Error(`send time read failed: ${error.message}`)
  const rows: SendStep[] = data ?? []
  return rows
}

/**
 * The `Submission__c` each of these Main Flow runs' trigger payloads holds
 * (#2939), runs started in [from, to), the window their relay posts were listed
 * by. workflow_executions is partitioned by its start, so the window bounds the
 * read too. Only that one key is read, never the payload. The ids are the relay
 * sample's, so never more than RELAY_SAMPLE_SIZE; more throws rather than read
 * part of them. Throws on a failed read.
 */
export async function readRunSubmissionIds(supabase: SupabaseClient, executionIds: string[], from: string, to: string): Promise<Map<string, unknown>> {
  if (executionIds.length === 0) return new Map()
  if (executionIds.length > RELAY_SAMPLE_SIZE) throw new Error(`the run Submission read was asked for ${executionIds.length} runs, more than the ${RELAY_SAMPLE_SIZE} it reads`)
  const { data, error } = await supabase
    .from('workflow_executions')
    .select('id, submission:trigger_payload->>Submission__c')
    .eq('workflow_id', MAIN_FLOW_WORKFLOW_ID)
    .in('id', executionIds)
    .gte('started_at', from)
    .lt('started_at', to)
    .limit(RELAY_SAMPLE_SIZE)
  if (error) throw new Error(`run Submission read failed: ${error.message}`)
  const rows = (data ?? []) as Array<{ id: string; submission: unknown }>
  return new Map(rows.map((r) => [r.id, r.submission]))
}

/** The production wiring for one subject: Main Flow's steps and definition, its organization's Salesforce and Slack. Never throws. */
export async function runCanaryWatchForEnv(subject: CanaryWatchSubject, supabase: SupabaseClient, env: Env): Promise<CanaryWatchReport> {
  const keys = secretKeys(env)
  let workflowPromise: Promise<{ organizationId: string; definition: unknown }> | null = null
  const workflow = () => {
    workflowPromise ??= (async () => {
      const { data, error } = await supabase.from('workflows').select('organization_id, definition').eq('id', MAIN_FLOW_WORKFLOW_ID).maybeSingle()
      if (error) throw new Error(`Main Flow could not be read: ${error.message}`)
      const row = data as { organization_id?: unknown; definition?: unknown } | null
      if (typeof row?.organization_id !== 'string') throw new Error('Main Flow was not found in the workflows table')
      return { organizationId: row.organization_id, definition: row.definition }
    })()
    return workflowPromise
  }
  const orgId = async () => (await workflow()).organizationId
  return runCanaryWatch(subject, {
    now: () => Date.now(),
    appUrl: env.APP_URL,
    livePorted: async () => {
      const definition = (await workflow()).definition as Definition | null
      if (!definition || !Array.isArray(definition.nodes)) throw new Error("Main Flow's definition has no nodes")
      return portStatus(definition).ported.includes(subject.step)
    },
    anyDirect: async (from, to) => {
      const { data, error } = await supabase
        .from('execution_steps')
        .select('id')
        .eq('workflow_id', MAIN_FLOW_WORKFLOW_ID)
        .eq('step_namespace', subject.step)
        .eq('step_type', 'salesforce')
        .gte('execution_started_at', from)
        .lt('execution_started_at', to)
        .not('is_test', 'is', true)
        .limit(1)
      if (error) throw new Error(`execution_steps read failed: ${error.message}`)
      return (data ?? []).length > 0
    },
    reportedBefore: async () => {
      // job_runs is this job's own daily record, one row a day; one row answers it.
      const { data, error } = await supabase.from('job_runs').select('id').eq('job', subject.job).neq('outcome', 'not_switched_on').limit(1)
      if (error) throw new Error(`job_runs read failed: ${error.message}`)
      return (data ?? []).length > 0
    },
    readSteps: (from, to) => readWatchedSteps(supabase, subject.step, from, to, subject.maxSteps),
    readRelay: (from, to) => readRelayPosts(supabase, from, to),
    readSendSteps: (executionId) => readSendSteps(supabase, executionId),
    readRunSubmissions: (executionIds, from, to) => readRunSubmissionIds(supabase, executionIds, from, to),
    salesforce: async () => {
      const port = await salesforcePortFor(env, supabase, keys, await orgId(), MAIN_FLOW_WORKFLOW_ID)
      return async (path: string): Promise<SalesforceRead> => {
        const raced = await raceDeadline(() => port.send('GET', path), SF_READ_DEADLINE_MS)
        if (raced.kind === 'ok') return { kind: 'answer', ...raced.value }
        return { kind: 'no_answer', error: raced.kind === 'threw' ? formatErr(raced.error) : `no answer within ${SF_READ_DEADLINE_MS / 1000} s` }
      }
    },
    post: async (message, alertKind) => {
      const slack = await getSlackConnection(supabase, await orgId())
      if (!slack) throw new Error("Main Flow's organization has no Slack connection")
      return (await postMessage(slack.bot_token, slack.default_channel, canaryWatchBlocks(message), message.title, alertKind)) !== null
    },
    recordRun: (startedAtMs, ending) => recordFinishedJobRun(supabase, subject.job, startedAtMs, ending),
  })
}

/** The invalid state canary's production wiring (#2173). */
export const runInvalidStateWatchForEnv = (supabase: SupabaseClient, env: Env): Promise<CanaryWatchReport> => runCanaryWatchForEnv(INVALID_STATE_SUBJECT, supabase, env)

/** The send_salesforce canary's production wiring (#2174). */
export const runSendSalesforceWatchForEnv = (supabase: SupabaseClient, env: Env): Promise<CanaryWatchReport> => runCanaryWatchForEnv(SEND_SALESFORCE_SUBJECT, supabase, env)
