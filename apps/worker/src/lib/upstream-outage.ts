/**
 * Shared-upstream outage aggregation (#331).
 *
 * When a dependency shared by many leads degrades (Salesforce slows past its
 * concurrency governor, a partner proxy 5xxes, outbound calls time out), the
 * engine fires one "Workflow Execution Failed" Slack alert PER affected lead.
 * During the 2026-06-23 Salesforce degradation that flooded the channel with
 * dozens of near-identical pages and buried the signal. The team wants ONE
 * actionable page per cause, not a per-lead flood.
 *
 * Two halves, both keyed off the same built-in cause signatures so they can't
 * drift:
 *   1. Suppression — the engine alert gate skips the per-run page when the
 *      error matches a built-in outage signature (classifyOutageCause). The run
 *      still records as `failed`; only the page is muted. Safe because these
 *      signatures are transient-upstream (SF 5xx / governor, partner proxy 5xx,
 *      timeout/abort) and cannot be confused with per-lead business errors
 *      (validation, duplicate, "reason: eq/in" code rejections), which still
 *      page per run.
 *   2. Aggregation — this minute cron counts matching failures across all
 *      active workflows in each Slack org, grouped by cause, and fires ONE
 *      @here alert per group when the count crosses the threshold, with a KV
 *      cooldown on the same key so a sustained outage pages once. The group is
 *      (org, cause) for a shared upstream, and (org, cause, workflow) for a
 *      cause marked `perWorkflow`, where the upstream belongs to one workflow
 *      and a shared cooldown would let one partner silence another (#1361).
 *
 * Mirrors the failure-rate.ts / volume-cliff.ts pattern (cron + windowed
 * workflow_executions query + KV cooldown + pure detector). The difference from
 * #248's failure-rate is that those signals are per-workflow opt-in config; a
 * shared-upstream outage hits many workflows at once, so these causes are
 * built-in and org-wide with no configuration.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logReadFailure } from './scheduled-read'
import { sendUpstreamOutageAlert, sendFailureSaturationAlert } from './slack'
import { fetchAllPaged } from './paginate'

export interface OutageCause {
  /** Stable id used in the cooldown key and alert payload. */
  key: string
  /** Human label shown in the aggregated alert. */
  label: string
  /** Case-insensitive substrings; the error matches this cause if ANY appears. */
  matchers: string[]
  /**
   * Whether this cause is scoped to ONE workflow rather than shared across them
   * (#1361).
   *
   * Every other cause here names a dependency many workflows call at once, so
   * one page for the org is exactly right. A partner API is the opposite: each
   * bidding workflow talks to a different partner, the remedy is to contact that
   * partner, and the cooldown would otherwise let one partner's outage silence
   * another's for thirty minutes. Measured 2026-09-15, GigFi and LendSwift both
   * degraded on the same day.
   *
   * Set it only when the upstream really is per-workflow: it multiplies the
   * pages a genuinely shared outage produces.
   */
  perWorkflow?: boolean
}

/**
 * Built-in shared-upstream outage signatures, derived from the real
 * `workflow_executions.error_message` strings these failures produce. Ordered
 * so a more specific, named upstream (Salesforce, Tripoint) wins over the
 * generic timeout bucket when a message could match both.
 *
 * Deliberately excludes per-lead business/code errors ("reason: eq/in" code
 * rejections, VALIDATION/DUPLICATE_VALUE, "expected rejection") — those are
 * lead-specific outcomes, not a degraded shared dependency, and must keep
 * paging per run.
 */
export const UPSTREAM_OUTAGE_CAUSES: OutageCause[] = [
  {
    key: 'salesforce',
    label: 'Salesforce',
    // SF 5xx edge timeouts (520/502/503) and the concurrency governor, which
    // surfaces as a 403 REQUEST_LIMIT_EXCEEDED / ConcurrentPerOrgLongTxn.
    matchers: [
      'salesforce api error (5',
      'concurrentperorglongtxn',
      'request_limit_exceeded',
    ],
  },
  {
    key: 'tripoint',
    label: 'Tripoint',
    matchers: ['tripoint proxy 5'],
  },
  {
    // Missing credentials/config hits every lead at once (a forgotten secret, or
    // the env-var loader returning blank during a DB blip — #391/#393), so it
    // belongs with the shared-outage signatures: suppress the per-lead flood and
    // fire one aggregated page. The 'env vars' token is unique to these node
    // cred/config errors ("... requires ... env vars", "Missing ... env vars")
    // and never appears in per-lead business/validation errors.
    key: 'missing_config',
    label: 'Missing credentials/config',
    matchers: ['env vars'],
  },
  {
    // A partner API answering with a server fault through a code node (#1361).
    //
    // Keyed on the partner's OWN words, never the HTTP status. The status on a
    // code node is chosen by the workflow author, so a per-lead business
    // rejection is also returned as a 500, and 'Code returned error response:
    // HTTP 5' would have swept those up and silenced them (L104). Measured over
    // the 7 days to 2026-09-16: 480 failures carry this text, all of them GigFi
    // or LendSwift 500s, and nothing else in the window contains it at all.
    //
    // Sits AFTER the named upstreams so a Salesforce or Tripoint message that
    // also happens to say this still reports as that vendor.
    key: 'partner_api',
    label: 'Partner API',
    matchers: ['internal server error'],
    perWorkflow: true,
  },
  {
    key: 'timeout',
    label: 'Upstream timeout',
    matchers: [
      'the operation was aborted',
      'canceled via abort signal',
      'did not complete in time',
      'parallel node timed out',
    ],
  },
]

/**
 * Failed-step node type -> named upstream cause key (#332). Used to re-attribute
 * a generic timeout/abort failure to the service that was actually slow, so a
 * Salesforce slowdown produces one "Salesforce" page instead of also a vaguer
 * "Upstream timeout" page. Only first-class service node types map cleanly;
 * code-node upstreams (Equifax, Tripoint-via-code) have node type 'code' and
 * stay in the generic timeout bucket.
 */
export const NODE_TYPE_TO_CAUSE = new Map<string, string>([
  ['salesforce', 'salesforce'],
])

/** The first cause whose any matcher appears (case-insensitively) in the error,
 *  or null when the error is not a recognized shared-upstream outage. */
export function classifyOutageCause(
  errorMessage: string | null | undefined,
  causes: OutageCause[] = UPSTREAM_OUTAGE_CAUSES,
): OutageCause | null {
  if (!errorMessage) return null
  const lower = errorMessage.toLowerCase()
  for (const cause of causes) {
    if (cause.matchers.some((m) => lower.includes(m))) return cause
  }
  return null
}

/**
 * Like classifyOutageCause, but re-attributes a GENERIC timeout/abort failure to
 * the named upstream of the failed step when one is known (#332). A named
 * error-message match (Salesforce governor, Tripoint 5xx) already identifies the
 * upstream and is left untouched; only the generic 'timeout' bucket is redirected.
 */
export function attributeOutageCause(
  errorMessage: string | null | undefined,
  failedStepType: string | null | undefined,
  causes: OutageCause[] = UPSTREAM_OUTAGE_CAUSES,
): OutageCause | null {
  const cause = classifyOutageCause(errorMessage, causes)
  if (!cause || cause.key !== 'timeout' || !failedStepType) return cause
  const mappedKey = NODE_TYPE_TO_CAUSE.get(failedStepType)
  if (!mappedKey) return cause
  return causes.find((c) => c.key === mappedKey) ?? cause
}

/** Resolve the failed step's node type from the workflow definition, for the
 *  `failed_step_type` written at finalize (#332). Null when no step failed or the
 *  namespace isn't in the definition. */
export function resolveFailedStepType(
  nodes: { namespace: string; type: string }[],
  failedNamespace: string | null | undefined,
): string | null {
  if (!failedNamespace) return null
  return nodes.find((n) => n.namespace === failedNamespace)?.type ?? null
}

/**
 * How many distinct error shapes the alert shows, and how long each sample may
 * be. Three shapes at 220 characters is roughly 700 characters of the 3000 a
 * Slack section allows, which leaves room for the rest of the message. The rest
 * of the shapes are counted rather than shown.
 */
export const MAX_ERROR_SHAPES = 3
export const MAX_SHAPE_SAMPLE_CHARS = 220

/**
 * A grouping key for an error message: the same real failure produces the same
 * key regardless of which lead it happened to.
 *
 * Calibrated against real messages rather than invented ones. A 60-row prod
 * sample on 2026-08-21 held 6 distinct raw strings for 4 real causes, because
 * three `Code returned error response` failures differed only by the lead's
 * UUID. Grouping on the raw string would report 31 "shapes" for one cause, which
 * is the fragmentation this exists to prevent.
 *
 * What it deliberately does NOT erase matters as much as what it does. A status
 * code carries the identity of the error, so a 403 governor rejection must not
 * merge with a 503 outage: those are different diagnoses with different
 * remedies. Only digits in positions that vary per lead are replaced, and an
 * id-shaped token has to carry BOTH letters and digits to qualify, so a long
 * word like ConcurrentPerOrgLongTxn survives (L104).
 */
export function normalizeErrorShape(message: string | null | undefined): string {
  if (!message) return ''
  return message
    // UUIDs first, since they would otherwise be partly eaten by the id rule.
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    // Salesforce ids: 15 or 18 characters carrying both letters and digits.
    .replace(/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{15}([A-Za-z0-9]{3})?\b/g, '<sfid>')
    // A duration or size, which varies run to run. Anchored on the unit so a
    // bare status code in brackets is left alone.
    .replace(/\b\d+(ms|s|kb|mb|bytes)\b/gi, '<n>$1')
    // Timestamps, which fragment a shape as thoroughly as an id.
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<ts>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** One distinct failure shape and how many rows collapsed into it. */
export interface ErrorShape {
  /** A representative raw message, truncated for display. */
  sample: string
  count: number
}

/**
 * The busiest distinct error shapes among a cause's messages, plus how many
 * shapes were left out.
 *
 * `otherShapeCount` is what keeps the aggregate honest: without it, the top
 * shape reads as the whole story even when the group holds several genuinely
 * different failures (L11).
 *
 * An empty or unparseable message contributes nothing rather than throwing. The
 * alert has to survive a group with no usable messages at all, because losing
 * the page is worse than sending it with only the cause label.
 */
export function topErrorShapes(
  messages: (string | null | undefined)[],
  limit: number = MAX_ERROR_SHAPES,
): { shapes: ErrorShape[]; otherShapeCount: number } {
  const byShape = new Map<string, { sample: string; count: number }>()
  for (const raw of messages) {
    const key = normalizeErrorShape(raw)
    if (!key) continue
    const existing = byShape.get(key)
    if (existing) existing.count++
    else byShape.set(key, { sample: truncateSample(String(raw).replace(/\s+/g, ' ').trim()), count: 1 })
  }
  const ranked = [...byShape.values()].sort((a, b) => b.count - a.count)
  return { shapes: ranked.slice(0, limit), otherShapeCount: Math.max(0, ranked.length - limit) }
}

function truncateSample(sample: string): string {
  if (sample.length <= MAX_SHAPE_SAMPLE_CHARS) return sample
  // Visible truncation: a cut string must not read as the whole message.
  return sample.slice(0, MAX_SHAPE_SAMPLE_CHARS - 3) + '...'
}

/** Signals that the failure is about OUR call pattern, not the vendor's health. */
const OUR_CALL_PATTERN_SIGNALS = [
  'concurrentperorglongtxn',
  'request_limit_exceeded',
  'limit exceeded',
  'too many requests',
  'rate limit',
  'throttl',
  '429',
]

/**
 * Signals that the failure came from OUR OWN code or configuration running
 * INSIDE the vendor's platform, not from the vendor being unwell (#1099).
 *
 * Salesforce returns HTTP 500 for an exception raised by our own Apex, so the
 * status code carries no information about Salesforce's health. On 2026-09-02 a
 * change set deployed at 12:20:05 UTC made `LeadTriggerHandler.buildSubmission`
 * write `Submission__c.RevolvingCreditLimit__c`, a formula field, and 168 Main
 * Flow runs failed over the next thirty minutes while the alert told the team to
 * check the Salesforce status page. Salesforce was entirely healthy.
 *
 * These have to be checked BEFORE the vendor-health signals, because the same
 * message satisfies both: the '(5' in VENDOR_HEALTH_SIGNALS matches
 * `Salesforce API error (500)` regardless of what the 500 carries.
 *
 * Each entry is a signature only an in-platform failure of ours produces. Kept
 * narrow deliberately (L104): the messages this must NOT capture are a governor
 * rejection, a 503, and a timeout, none of which name a class, a trigger or a
 * validation rule.
 */
const OUR_OWN_CODE_SIGNALS = [
  // Apex or a validation rule refused the write. Both are our own metadata.
  'cannot_insert_update_activate_entity',
  'field_custom_validation_exception',
  // An Apex exception type, and the stack frame format Apex reports them in.
  'system.sobjectexception',
  'system.dmlexception',
  'system.nullpointerexception',
  'system.queryexception',
  'system.limitexception',
  // A field the schema does not allow us to write, which is a formula field or
  // a field-level-security setting, never a vendor incident.
  'is not editable',
  'is not writeable',
]

/** Signals that the vendor itself is unwell. */
const VENDOR_HEALTH_SIGNALS = [
  '(5',
  'service unavailable',
  'bad gateway',
  'gateway timeout',
  'timed out',
  'abort',
  // A partner naming its own server fault (#1361). Safe to read as vendor health
  // because the two rules above are tested first, so a Salesforce 500 wrapping
  // our own Apex still points at our recent deploys rather than their status page.
  'internal server error',
]

/**
 * What to actually go and look at, derived from the dominant shape rather than
 * asserted (L36).
 *
 * The alert used to say "confirm <vendor> health (status page / direct call)"
 * whatever had happened. On 2026-08-17 that sent the reader to the Salesforce
 * status page for 31 runs rejected by Salesforce's concurrency governor, which
 * is a fact about our own volume. So a limit or throttle signal now points at the
 * call pattern instead.
 *
 * On 2026-09-02 it did it again in the other direction (#1099): a Salesforce 500
 * wrapping an exception from our own Apex trigger matched the '(5' vendor-health
 * signal, so the alert sent the reader to Salesforce's status page for a fault
 * that a change set deployed sixteen seconds earlier had caused. So a signature
 * naming our own class, trigger or validation rule now points at recent deploys,
 * and is tested first because the same message satisfies the vendor-health rule.
 *
 * Judged on the DOMINANT shape only. A minority governor rejection among mostly
 * timeouts must not claim a concurrency problem. With nothing to judge, it names
 * no cause at all rather than guessing, because the wrong steer is worse than
 * none.
 */
export function describeHowToCheck(causeLabel: string, shapes: ErrorShape[]): string {
  const dominant = shapes[0]
  if (!dominant) {
    return `Review the affected runs to see what they failed on. Not enough detail was captured to narrow this down here.`
  }
  const lower = dominant.sample.toLowerCase()
  if (OUR_CALL_PATTERN_SIGNALS.some((sig) => lower.includes(sig))) {
    return (
      `The dominant error is a limit or governor rejection, which is about our own call pattern and volume ` +
      `rather than ${causeLabel} being down. Check concurrent in-flight calls and recent volume first.`
    )
  }
  if (OUR_OWN_CODE_SIGNALS.some((sig) => lower.includes(sig))) {
    return (
      `The dominant error was raised by our own code or configuration running inside ${causeLabel}, ` +
      `not by ${causeLabel} being unwell, so checking their health will not explain it. Look at what ` +
      `was deployed there recently (in Salesforce, the Setup Audit Trail plus the Apex class and field ` +
      `definitions the error names) and review the affected runs.`
    )
  }
  if (VENDOR_HEALTH_SIGNALS.some((sig) => lower.includes(sig))) {
    return `Confirm ${causeLabel} health (status page / direct call), then review the affected runs.`
  }
  return `Review the affected runs, starting with the dominant error above.`
}

/** Whether a windowed count should fire the aggregated alert. */
export function detectOutageSpike(count: number, threshold: number): boolean {
  if (threshold <= 0) return false
  return count >= threshold
}

// A spike is ~10 failures sharing a cause within a single minute (Dan, 2026-06-23).
// The check runs on the minute cron, so the window is the trailing 60 seconds.
export const DEFAULT_OUTAGE_THRESHOLD = 10
export const DEFAULT_OUTAGE_WINDOW_MINUTES = 1
export const DEFAULT_COOLDOWN_MINUTES = 30
// Cap the started_at floor so the scan stays partition-pruned.
export const LOOKBACK_MINUTES = 60

interface FailedRow {
  workflow_id: string
  error_message: string | null
  completed_at: string | null
  /**
   * When the run STARTED. Carried because saturation's denominator
   * (`execution_counts_per_minute`) buckets by started_at, so its numerator has
   * to as well or the two count different runs (#1100, L16).
   */
  started_at?: string | null
  /** Node type of the step that failed, used to attribute generic timeouts (#332). */
  failed_step_type?: string | null
}

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

export interface OutageGroup {
  cause: OutageCause
  count: number
  workflowNames: string[]
  /**
   * The one workflow this group is about, for a `perWorkflow` cause only (#1361).
   * Undefined for a shared cause, whose group spans every affected workflow.
   */
  workflowId?: string
  /** The busiest distinct error shapes behind this cause, busiest first (#834). */
  shapes: ErrorShape[]
  /** Distinct shapes not shown, so the top one does not read as the whole story. */
  otherShapeCount: number
}

/**
 * Aggregate failed rows (already scoped to one org's workflows) by outage cause,
 * counting only rows that completed on/after windowStartMs. Pure — the windowed
 * core of the aggregated check. Returns groups with count > 0, busiest first.
 */
export function groupOutages(
  rows: FailedRow[],
  workflowNameById: Map<string, string>,
  windowStartMs: number,
  causes: OutageCause[] = UPSTREAM_OUTAGE_CAUSES,
): OutageGroup[] {
  const byCause = new Map<
    string,
    {
      cause: OutageCause
      count: number
      workflows: Set<string>
      messages: (string | null)[]
      workflowId?: string
    }
  >()
  for (const r of rows) {
    if (!r.completed_at || new Date(r.completed_at).getTime() < windowStartMs) continue
    const cause = attributeOutageCause(r.error_message, r.failed_step_type, causes)
    if (!cause) continue
    // A per-workflow cause gets one group per workflow, so its count, its shapes
    // and its cooldown are all about the one partner the page names (#1361).
    const groupKey = cause.perWorkflow ? `${cause.key}|${r.workflow_id}` : cause.key
    let g = byCause.get(groupKey)
    if (!g) {
      g = {
        cause,
        count: 0,
        workflows: new Set(),
        messages: [],
        workflowId: cause.perWorkflow ? r.workflow_id : undefined,
      }
      byCause.set(groupKey, g)
    }
    g.count++
    // Collected from the SAME rows the count is built from, and inside the same
    // window guard, so the shapes can never describe runs the count excluded.
    g.messages.push(r.error_message)
    const name = workflowNameById.get(r.workflow_id)
    if (name) g.workflows.add(name)
  }
  return [...byCause.values()]
    .map((g) => {
      const { shapes, otherShapeCount } = topErrorShapes(g.messages)
      return {
        cause: g.cause,
        count: g.count,
        workflowNames: [...g.workflows],
        workflowId: g.workflowId,
        shapes,
        otherShapeCount,
      }
    })
    .sort((a, b) => b.count - a.count)
}

// ---------------------------------------------------------------------------
// Failure saturation (#1100)
// ---------------------------------------------------------------------------

/**
 * The share of a window's runs that must have failed before saturation fires,
 * and the smallest window worth judging.
 *
 * MEASURED, not chosen. Over the five days to 2026-09-02 there were 5,238
 * five-minute buckets holding at least 10 non-test runs. Their failure shares:
 *
 *      0%        5,151 buckets
 *    0 to 5%        28
 *    5 to 15%       22
 *   15 to 30%       20
 *   30 to 50%        5
 *   50 to 75%        4
 *   75 to 100%       8
 *
 * So 0.5 sits in a genuine gap rather than inside the dense part of the
 * distribution (L172): the twelve buckets at or above it are three real
 * incidents and nothing else, and each incident collapses to one page under the
 * cooldown. Re-measure before moving it, because the shape of that tail is the
 * whole argument.
 *
 * MIN_SATURATION_RUNS exists because a share alone cannot tell 2 of 2 from 200
 * of 200, and every workflow is briefly at 100% when it has one failing run and
 * nothing else. Ten runs in five minutes is the same floor the bucket
 * measurement used, so the distribution above describes exactly the population
 * this will judge.
 *
 * DELIBERATE BLIND SPOT (L308): a workflow that never reaches ten runs in five
 * minutes can never trip this, so a total outage on a genuinely quiet lane is
 * still only caught by the absolute count or by a person. Widening the window
 * would fix that and would also delay every alert, so it is left alone until
 * something asks for it.
 */
export const SATURATION_SHARE = 0.5
export const MIN_SATURATION_RUNS = 10
/**
 * The window saturation is judged over, in minutes.
 *
 * Wider than DEFAULT_OUTAGE_WINDOW_MINUTES because the whole point is a lane
 * whose per-minute count is small: five minutes of Main Flow at 8am is about 35
 * runs, which clears MIN_SATURATION_RUNS, while one minute is about 7 and does
 * not. On the 2026-09-02 incident this reaches its verdict around 12:24, against
 * the 12:38 the absolute count actually managed.
 */
export const SATURATION_WINDOW_MINUTES = 5

/**
 * Whether a window's failures are saturated: enough runs to judge, and at least
 * SATURATION_SHARE of them failed.
 *
 * Returns false rather than throwing on a zero denominator, because an idle
 * workflow is a normal state and not an error.
 */
export function detectFailureSaturation(failed: number, total: number): boolean {
  if (total < MIN_SATURATION_RUNS) return false
  if (failed > total) return false
  return failed / total >= SATURATION_SHARE
}

/** One workflow whose window is saturated, with what the page needs to say. */
export interface SaturationGroup {
  workflowId: string
  workflowName: string
  failureCount: number
  totalCount: number
  /** The busiest distinct error shapes, busiest first, so the page names them. */
  shapes: ErrorShape[]
  otherShapeCount: number
}

/**
 * Per-workflow saturation over the window, cause-agnostic.
 *
 * The numerator and denominator must describe the SAME population (L16), and
 * they come from different places: the failures are fetched with a completed_at
 * floor, while `runTotals` comes from `execution_counts_per_minute`, which
 * buckets by started_at. So the failures are re-windowed here on STARTED_AT, and
 * a workflow whose failure count exceeds its run total is REFUSED rather than
 * reported: that disagreement means the two sides are not describing the same
 * runs, and a share above 1 is evidence of that rather than a very bad outage
 * (L340, and clamping it would destroy the only sign anything was wrong).
 */
export function groupSaturation(
  rows: FailedRow[],
  runTotals: Map<string, number>,
  workflowNameById: Map<string, string>,
  windowStartMs: number,
): SaturationGroup[] {
  const failuresByWorkflow = new Map<string, (string | null)[]>()
  for (const r of rows) {
    if (!r.started_at) continue
    if (new Date(r.started_at).getTime() < windowStartMs) continue
    const list = failuresByWorkflow.get(r.workflow_id) ?? []
    list.push(r.error_message)
    failuresByWorkflow.set(r.workflow_id, list)
  }

  const out: SaturationGroup[] = []
  for (const [workflowId, messages] of failuresByWorkflow) {
    const total = runTotals.get(workflowId) ?? 0
    const failed = messages.length
    if (failed > total) {
      console.error(
        `[failure-saturation] refusing workflow=${workflowId}: ${failed} failures against ` +
          `${total} runs in the window, so the two sources disagree about which runs they cover`,
      )
      continue
    }
    if (!detectFailureSaturation(failed, total)) continue
    const name = workflowNameById.get(workflowId)
    if (!name) continue
    const { shapes, otherShapeCount } = topErrorShapes(messages)
    out.push({ workflowId, workflowName: name, failureCount: failed, totalCount: total, shapes, otherShapeCount })
  }
  return out.sort((a, b) => b.failureCount - a.failureCount)
}

/**
 * Aggregated upstream-outage check (#331). Every minute: for each org with Slack
 * connected, count matching failed runs across its active workflows in the
 * trailing window, group by cause, and fire ONE @here alert per cause whose
 * count crosses the threshold. Cooldown per (org, cause) so a sustained outage
 * pages once.
 */
export async function runUpstreamOutageCheck(
  supabase: SupabaseClient,
  kv: KvLike,
  appUrl: string,
): Promise<void> {
  const { data: slackOrgs, error: slackOrgsError } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  logReadFailure('upstream-outage', 'slack connections', slackOrgsError)
  const slackOrgIds = (slackOrgs ?? []).map((c) => c.organization_id as string)
  if (slackOrgIds.length === 0) return

  const { data: workflows, error: workflowsError } = await supabase
    .from('workflows')
    .select('id, name, organization_id')
    .in('organization_id', slackOrgIds)
    .eq('is_active', true)
    .is('deleted_at', null)
  logReadFailure('upstream-outage', 'workflows', workflowsError)
  if (!workflows?.length) return

  const now = Date.now()
  const workflowIds = workflows.map((w) => w.id as string)
  const nameById = new Map(workflows.map((w) => [w.id as string, w.name as string]))
  const orgByWorkflow = new Map(workflows.map((w) => [w.id as string, w.organization_id as string]))

  const windowStartMs = now - DEFAULT_OUTAGE_WINDOW_MINUTES * 60 * 1000
  // Saturation judges a wider window than the cause rule (#1100), so ONE fetch
  // covers the wider of the two and each detector filters it down. Fetching
  // twice a minute for two views of the same rows would be the same query run
  // twice.
  const saturationStartMs = now - SATURATION_WINDOW_MINUTES * 60 * 1000
  const fetchFromMs = Math.min(windowStartMs, saturationStartMs)
  const lookbackStart = new Date(now - LOOKBACK_MINUTES * 60 * 1000).toISOString()
  const windowStart = new Date(fetchFromMs).toISOString()

  const failed = await fetchAllPaged<FailedRow>(
    (from, to) => supabase
      .from('workflow_executions')
      .select('workflow_id, error_message, completed_at, started_at, failed_step_type')
      .in('workflow_id', workflowIds)
      .gte('started_at', lookbackStart)
      .gte('completed_at', windowStart)
      .eq('is_test', false)
      .eq('status', 'failed')
      .not('error_message', 'is', null)
      .order('completed_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
    'upstream-outage failed query',
  )

  // Run totals for saturation's denominator, from the same started_at basis its
  // numerator is windowed on. A read failure leaves the map EMPTY, which makes
  // every workflow's total zero and therefore unjudged: saturation says nothing
  // rather than accusing a workflow on a denominator it could not read (L215).
  const runTotals = new Map<string, number>()
  const { data: totalsData, error: totalsError } = await supabase.rpc('execution_counts_per_minute', {
    p_workflow_ids: workflowIds,
    p_since: new Date(saturationStartMs).toISOString(),
  })
  logReadFailure('failure-saturation', 'execution_counts_per_minute', totalsError)
  // A count that will not parse makes the WHOLE workflow unjudgeable, not just
  // that one minute (L50). PostgREST renders a bigint as a string, so these are
  // parsed, and SKIPPING a bad row would understate the denominator, which
  // overstates the failure share: the direction that pages a healthy workflow.
  // Refusing is the fail-safe side, and it is logged so a persistent parse
  // problem is visible rather than reading as a quiet workflow.
  const unreadableTotals = new Set<string>()
  for (const r of (totalsData ?? []) as { workflow_id: string; cnt: number | string }[]) {
    const n = Number(r.cnt)
    if (!Number.isFinite(n)) {
      unreadableTotals.add(r.workflow_id)
      continue
    }
    runTotals.set(r.workflow_id, (runTotals.get(r.workflow_id) ?? 0) + n)
  }
  for (const workflowId of unreadableTotals) {
    console.error(
      `[failure-saturation] not judging workflow=${workflowId}: at least one run count in the ` +
        `window could not be read, so its denominator would be understated and its failure share overstated`,
    )
    runTotals.delete(workflowId)
  }

  // Partition the failures by org, then group each org's failures by cause.
  const rowsByOrg = new Map<string, FailedRow[]>()
  for (const r of failed) {
    const org = orgByWorkflow.get(r.workflow_id)
    if (!org) continue
    const list = rowsByOrg.get(org) ?? []
    list.push(r)
    rowsByOrg.set(org, list)
  }

  for (const [orgId, rows] of rowsByOrg) {
    // Saturation first: it is the rule that can see a lane whose per-minute
    // count is too small for the absolute threshold, so it must not be gated on
    // anything the cause rule decides.
    for (const sat of groupSaturation(rows, runTotals, nameById, saturationStartMs)) {
      const satCooldownKey = `failure-saturation-cooldown:${orgId}:${sat.workflowId}`
      if (await kv.get(satCooldownKey)) continue
      console.log(
        `[failure-saturation] org=${orgId} workflow=${sat.workflowId} ` +
          `${sat.failureCount}/${sat.totalCount} failed in ${SATURATION_WINDOW_MINUTES}m`,
      )
      const satSent = await sendFailureSaturationAlert(
        supabase,
        orgId,
        {
          workflow_id: sat.workflowId,
          workflow_name: sat.workflowName,
          failure_count: sat.failureCount,
          total_count: sat.totalCount,
          window_minutes: SATURATION_WINDOW_MINUTES,
          error_shapes: sat.shapes,
          other_shape_count: sat.otherShapeCount,
          timestamp: new Date(now).toISOString(),
        },
        appUrl,
      )
      // Only start the cooldown once it actually delivered, so a kicked bot
      // retries next minute instead of buying thirty minutes of silence.
      if (satSent) {
        await kv.put(satCooldownKey, '1', { expirationTtl: DEFAULT_COOLDOWN_MINUTES * 60 })
      }
    }

    const groups = groupOutages(rows, nameById, windowStartMs)
    for (const group of groups) {
      if (!detectOutageSpike(group.count, DEFAULT_OUTAGE_THRESHOLD)) continue

      // A per-workflow cause carries the workflow into its own key, so one
      // partner's outage cannot silence another's for the cooldown (#1361).
      const cooldownKey =
        `upstream-outage-cooldown:${orgId}:${group.cause.key}` +
        (group.workflowId ? `:${group.workflowId}` : '')
      if (await kv.get(cooldownKey)) continue

      console.log(`[upstream-outage] org=${orgId} cause=${group.cause.key} count=${group.count}/${DEFAULT_OUTAGE_THRESHOLD} window=${DEFAULT_OUTAGE_WINDOW_MINUTES}m workflows=${group.workflowNames.length}`)

      const sent = await sendUpstreamOutageAlert(
        supabase,
        orgId,
        {
          cause_key: group.cause.key,
          cause_label: group.cause.label,
          failure_count: group.count,
          window_minutes: DEFAULT_OUTAGE_WINDOW_MINUTES,
          workflow_names: group.workflowNames,
          error_shapes: group.shapes,
          other_shape_count: group.otherShapeCount,
          how_to_check: describeHowToCheck(group.cause.label, group.shapes),
          timestamp: new Date(now).toISOString(),
        },
        appUrl,
      )

      if (sent) {
        await kv.put(cooldownKey, '1', { expirationTtl: DEFAULT_COOLDOWN_MINUTES * 60 })
      }
    }
  }
}
