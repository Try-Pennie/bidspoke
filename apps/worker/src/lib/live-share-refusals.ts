/**
 * The page for a buyer_select live share that refuses every lead (#2149).
 *
 * From 2026-10-13 16:09 to 2026-10-15 12:58 UTC every one of 60 Engine canary
 * leads (BUYER_SELECT_ENGINE_PERCENT 1) was refused as missing_lead_field:
 * Tripoint's profile had gained a 2,000 minimum loan amount and the node had no
 * loan amount template. Those leads skipped tripoint_ping too, about 20 sales
 * were lost, and nothing paged: the buyer outcome rate check reads buyer_sales,
 * which a refused lead never reaches, and at 1 percent it never sees enough
 * attempts in an hour anyway. The save checks (buyer-input-coverage.ts) now
 * refuse that state; this is the backstop for what a save cannot see, such as
 * a template whose path the lead does not carry.
 *
 * WHAT IS JUDGED. Each live buyer_select step of a switched on workflow. A live
 * share lead is a step row with mode_effective live that reached the buyers
 * (route sold or no_sale), read from the node's own record of what it did, never
 * re-derived from the eligibility rule it applies (L721). A lead is SENT when a
 * buyer was called (sale.skipped false), REFUSED when none was, and NEUTRAL when
 * every buyer was out for a reason somebody chose (CHOSEN_REASONS: closed
 * hours, a day off, switched off, a cap reached) or the lead was already held
 * elsewhere, because those say nothing about whether the step works. The run is
 * the refused leads since the newest sent one.
 *
 * THE FLOOR AND THE WINDOW are counted in LEADS, never hours (L716), so the
 * check speeds up by itself when the live share grows. Measured on production
 * for the fixture this file's test replays (2026-10-11 to 2026-10-18 17:31 UTC,
 * 223 live share leads):
 *   - the live share sees about 28 leads a day (74 in the 64 hours before the
 *     fault, 88 in the 74.5 hours after the fix), the fewest in a whole day 17
 *     (Saturday 2026-10-17), with gaps of up to 9 hours between leads overnight;
 *   - since Tripoint's own 2,000 floor (both arms from 2026-10-15 15:00 UTC), 43
 *     of 88 leads were refused for a loan under it (49 percent), and the longest
 *     run of refused leads was 6.
 * A run of REFUSAL_RUN_FLOOR (20) by chance at a 49 percent refusal share is
 * about 0.51 x 0.49^20, or 3 in 10 million per lead: once in several centuries
 * at 28 leads a day. Even at 60 percent it is about once in 7 years. Below 20
 * the risk climbs fast (15 at 60 percent is about twice a year), and one
 * coincidence page teaches people to skip this one (L36, L139). A proportion
 * below 100 percent is not judged at all: at this volume near 100 percent and
 * 100 percent cannot be told apart, so the claim made is the one the count can
 * carry, every lead.
 * LOOKBACK_MS (48 hours) holds 20 leads at the slowest whole day measured (17 a
 * day reaches 20 in about 28 hours) with room for a quiet weekend. Fewer than
 * the floor in the lookback with nothing sent is TOO_FEW: recorded in job_runs
 * as unmeasured, never as ok and never paged (L90).
 * Replayed hourly over the measured days, the check pages first at 2026-10-14
 * 11:00 UTC, 19 hours into the 45 hour gap, on every hour until the first lead
 * sent after the fix, and at no other hour (live-share-refusals.test.ts).
 *
 * THE READ walks back from now in READ_WINDOW_MS windows on the
 * (workflow_id, step_namespace, started_at) index and stops at the first window
 * holding a sent lead, so on a normal hour it is one six hour read. A long
 * read of older partitions is slow when they are cold (72 hours took 49 s on
 * 2026-10-18; 6 hours 31 ms warm), which is why it is not one fixed long read.
 *
 * Pages go through the shared export alerter under LIVE_SHARE_REFUSALS_JOB, so
 * the standing page backs off, a mute uses the same keys, and a run with no
 * finding stands it down (signal export-alert, which arms no all-clear marker).
 * The run records itself in job_runs (L557) and both heartbeat stamps are
 * written by the cron wiring (L514).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { OUT_REASON_LABELS, NODE_REASON_LABELS, type NodeReason, type OutReason } from '@bidspoke/buyer-profile'
import type { Env } from '../index'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { formatErr } from './format-error'
import { withJobRun, type JobRunEnding } from './job-run-record'
import { fetchAllPaged } from './paginate'
import { etTime } from './slack'

/** The heartbeat, job_runs and alerter name. */
export const LIVE_SHARE_REFUSALS_JOB = 'live-share-refusals'

const HOUR = 3_600_000

/** Refused leads in a row, with none sent, that page. See the header for the measurement. */
export const REFUSAL_RUN_FLOOR = 20
/** How far back a run is followed: 20 leads at the slowest whole day measured, with room. */
export const LOOKBACK_MS = 48 * HOUR
/** One read's span. */
export const READ_WINDOW_MS = 6 * HOUR

/**
 * Reasons a person chose: a lead every buyer refused only for these is neither
 * sent nor refused. Hours, days off, switches and caps are settings working;
 * already_sold and sale_in_flight are the lead held by another execution.
 */
export const CHOSEN_REASONS = [
  'inactive', 'profile_disabled', 'closed', 'blackout',
  'hourly_lead_cap', 'daily_lead_cap', 'hourly_spend_cap', 'daily_spend_cap',
  'already_sold', 'sale_in_flight',
] as const satisfies readonly OutReason[]
const CHOSEN: ReadonlySet<string> = new Set(CHOSEN_REASONS)

// ── Shapes ────────────────────────────────────────────────────────────────────

/** One live share lead: when, whether a buyer was called, and if not each buyer's reason (partner null for the step's own). */
export interface LiveShareLead {
  at: string
  contacted: boolean
  refusals: Array<{ partner: string | null; reason: string }>
}

export interface LiveShareSubject {
  orgId: string
  workflowId: string
  workflowName: string
  namespace: string
  /** What the canvas shows for the step: its label, else its namespace. */
  label: string
  /** The variable that sets the live share, named in the page so it can be set to 0. */
  livePercentEnv: string | null
}

export type RunVerdict =
  | { verdict: 'refusing'; count: number; since: string; lastContactAt: string | null; reasons: Array<{ partner: string | null; reason: string; count: number }> }
  | { verdict: 'ok'; count: number; lastContactAt: string | null }
  | { verdict: 'too_few'; count: number }

// ── The judgement ─────────────────────────────────────────────────────────────

/**
 * The run of refused leads since the newest sent one, given leads newest first.
 * Pages at the floor; below it with a sent lead found, ok; below it with none
 * found in what was read, too few to say.
 */
export function judgeRun(newestFirst: readonly LiveShareLead[], floor = REFUSAL_RUN_FLOOR): RunVerdict {
  let count = 0
  let since: string | null = null
  let lastContactAt: string | null = null
  const tally = new Map<string, { partner: string | null; reason: string; count: number }>()
  for (const lead of newestFirst) {
    if (lead.contacted) {
      lastContactAt = lead.at
      break
    }
    if (lead.refusals.length > 0 && lead.refusals.every((r) => CHOSEN.has(r.reason))) continue
    count++
    since = lead.at
    for (const r of lead.refusals) {
      if (CHOSEN.has(r.reason)) continue
      const key = `${r.partner ?? ''}\u0000${r.reason}`
      const entry = tally.get(key) ?? { partner: r.partner, reason: r.reason, count: 0 }
      entry.count++
      tally.set(key, entry)
    }
  }
  if (count >= floor && since !== null) {
    return { verdict: 'refusing', count, since, lastContactAt, reasons: [...tally.values()].sort((a, b) => b.count - a.count) }
  }
  if (lastContactAt === null) return { verdict: 'too_few', count }
  return { verdict: 'ok', count, lastContactAt }
}

/** A step row as read: started_at and the three output fields the judgement needs. */
export interface LiveShareRow {
  started_at: string
  sale: unknown
  considered: unknown
  reason: unknown
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * One row as a lead. A row whose sale record is not readable is null and is
 * counted by the caller as unreadable, never as sent or refused (L11).
 */
export function leadFromRow(row: LiveShareRow): LiveShareLead | null {
  if (!isRecord(row.sale) || typeof row.sale.skipped !== 'boolean') return null
  if (row.sale.skipped === false) return { at: row.started_at, contacted: true, refusals: [] }
  const considered = Array.isArray(row.considered) ? row.considered.filter(isRecord) : []
  const refusals = considered
    .filter((c) => typeof c.reason === 'string')
    .map((c) => ({ partner: typeof c.partner === 'string' ? c.partner : null, reason: c.reason as string }))
  if (refusals.length > 0) return { at: row.started_at, contacted: false, refusals }
  // No buyer considered at all, or none named a reason: the step's own reason.
  return { at: row.started_at, contacted: false, refusals: [{ partner: null, reason: typeof row.reason === 'string' ? row.reason : 'unknown' }] }
}

// ── Subjects ──────────────────────────────────────────────────────────────────

interface WorkflowRow {
  id: string
  organization_id: string
  name: string
  is_active: boolean | null
  definition: unknown
}

/** Every buyer_select step configured live, on a switched on workflow. */
export function subjectsFromWorkflows(rows: readonly WorkflowRow[]): LiveShareSubject[] {
  const out: LiveShareSubject[] = []
  for (const w of rows) {
    if (w.is_active !== true) continue
    const nodes = (w.definition as { nodes?: unknown } | null | undefined)?.nodes
    if (!Array.isArray(nodes)) continue
    for (const n of nodes) {
      if (!isRecord(n) || n.type !== 'buyer_select' || typeof n.namespace !== 'string') continue
      const config = isRecord(n.config) ? n.config : {}
      if (config.mode !== 'live') continue
      const label = typeof n.label === 'string' && n.label.trim() !== '' ? n.label.trim() : n.namespace
      const env = typeof config.live_percent_env === 'string' && config.live_percent_env.trim() !== '' ? config.live_percent_env.trim() : null
      out.push({ orgId: w.organization_id, workflowId: w.id, workflowName: w.name, namespace: n.namespace, label, livePercentEnv: env })
    }
  }
  return out
}

// ── The run ───────────────────────────────────────────────────────────────────

export interface LiveShareDeps {
  listSubjects(): Promise<LiveShareSubject[]>
  /** The subject's live share leads started inside [fromMs, toMs), any order. */
  readLeads(subject: LiveShareSubject, fromMs: number, toMs: number): Promise<LiveShareLead[]>
  /** The page: the lines, one meaning key per line, and its wording. Called with no lines to stand a page down. */
  notify(lines: string[], keys: string[], remedy: AlertRemedy): Promise<void>
  now(): number
  localDev: boolean
  appUrl: string
}

export interface LiveShareSubjectSummary {
  workflow_id: string
  namespace: string
  verdict: RunVerdict['verdict'] | 'unmeasured'
  count: number | null
  last_contact_at: string | null
  windows_read: number
  detail?: string
}

export interface LiveShareSummary {
  skipped?: 'local_dev'
  subjects: LiveShareSubjectSummary[]
  paged_lines: number
}

/** The reason as the execution view words it. */
function reasonLabel(reason: string): string {
  const out = (OUT_REASON_LABELS as Record<string, string>)[reason as OutReason]
  if (out) return out.charAt(0).toLowerCase() + out.slice(1)
  const node = (NODE_REASON_LABELS as Record<string, string>)[reason as NodeReason]
  if (node) return node.charAt(0).toLowerCase() + node.slice(1)
  return reason
}

function refusingLine(subject: LiveShareSubject, v: Extract<RunVerdict, { verdict: 'refusing' }>, appUrl: string): string {
  const last = v.lastContactAt
    ? `The last lead sent to a buyer was at ${etTime(v.lastContactAt)}.`
    : `No lead was sent to a buyer in the ${LOOKBACK_MS / HOUR} hours read.`
  const reasons = v.reasons.map((r) => `${r.partner ?? 'no buyer'} on ${r.count}, ${reasonLabel(r.reason)}`).join('; ')
  const share = subject.livePercentEnv ? ` Setting ${subject.livePercentEnv} to 0 stops the loss while you look.` : ''
  return (
    `${subject.workflowName}, step ${subject.label}: the live share sent none of its last ${v.count} leads to a buyer, refusing every one since ${etTime(v.since)}. ` +
    `${last} Refused: ${reasons}.${share} ${appUrl}/workflows/${subject.workflowId}`
  )
}

export const LIVE_SHARE_REFUSALS_REMEDY: AlertRemedy = {
  headlineVerb: 'found a live share refusing every lead',
  itemNoun: { one: 'step', many: 'steps' },
  consequence:
    'A buyer selection step selling live refused every lead of its live share for longer than chance explains. Each of those leads ' +
    'was sold to no buyer by this step; whether it went anywhere else depends on what the workflow does after no sale (on the ' +
    'Engine flow, nothing: such a lead skips tripoint_ping too). Each line names the workflow, the step and why each buyer refused:',
  fixHint:
    'A missing lead field, or collections not wired, means the step has no template for a rule in the buyer profile, or a template ' +
    "whose path the lead does not carry: compare the step's State, Debt, Loan amount and Collections templates with a recent lead " +
    "and with the buyer's profile on the partners page. Any other reason on every lead usually means the profile or a template " +
    'changed: check the partner history and the workflow versions for the time the run began.',
}

const UNREAD_FIX =
  'A read of execution_steps that timed out is usually the database under load or a cold partition: the next hourly run reads ' +
  'again. One that keeps failing, or a row with no readable sale record, needs the step rows looked at by hand.'

/** The page for a run that could read nothing it judges. */
export const LIVE_SHARE_REFUSALS_UNREAD_REMEDY: AlertRemedy = {
  headlineVerb: 'could not read what it judges',
  consequence:
    'The live share refusal check could not read the leads of a live buyer selection step, so it measured nothing for what each ' +
    'line names. Each line names the read that failed and its error:',
  fixHint: UNREAD_FIX,
}

/** The remedy for a page: the finding's, saying so when some lines are failed reads; the read failure's alone otherwise. */
export function remedyFor(findings: number, unread: number): AlertRemedy {
  if (findings === 0 && unread > 0) return LIVE_SHARE_REFUSALS_UNREAD_REMEDY
  if (unread === 0) return LIVE_SHARE_REFUSALS_REMEDY
  return {
    ...LIVE_SHARE_REFUSALS_REMEDY,
    consequence: `${LIVE_SHARE_REFUSALS_REMEDY.consequence.replace(/:$/, '.')} A line saying a read failed measured nothing for what it names:`,
    fixHint: `${LIVE_SHARE_REFUSALS_REMEDY.fixHint} ${UNREAD_FIX}`,
  }
}

/** Walks the subject's leads back from now, a window at a time, until one was sent or the lookback is spent. */
async function readRun(deps: LiveShareDeps, subject: LiveShareSubject, nowMs: number): Promise<{ newestFirst: LiveShareLead[]; windows: number }> {
  const floorMs = nowMs - LOOKBACK_MS
  const newestFirst: LiveShareLead[] = []
  let windows = 0
  for (let to = nowMs; to > floorMs; to -= READ_WINDOW_MS) {
    const from = Math.max(to - READ_WINDOW_MS, floorMs)
    const leads = await deps.readLeads(subject, from, to)
    windows++
    newestFirst.push(...[...leads].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)))
    if (leads.some((l) => l.contacted)) break
  }
  return { newestFirst, windows }
}

export async function runLiveShareRefusals(deps: LiveShareDeps): Promise<LiveShareSummary> {
  if (deps.localDev) return { skipped: 'local_dev', subjects: [], paged_lines: 0 }
  const nowMs = deps.now()
  const lines: string[] = []
  const keys: string[] = []
  const subjects: LiveShareSubjectSummary[] = []
  let unread = 0

  let list: LiveShareSubject[]
  try {
    list = await deps.listSubjects()
  } catch (err) {
    const detail = `the live workflows could not be read: ${formatErr(err)}`
    await deps.notify([`The live share refusal check could not run: ${detail}.`], ['list'], LIVE_SHARE_REFUSALS_UNREAD_REMEDY)
    return { subjects: [{ workflow_id: '', namespace: '', verdict: 'unmeasured', count: null, last_contact_at: null, windows_read: 0, detail }], paged_lines: 1 }
  }

  for (const subject of list) {
    const key = `${subject.workflowId}:${subject.namespace}`
    let read
    try {
      read = await readRun(deps, subject, nowMs)
    } catch (err) {
      const detail = formatErr(err)
      lines.push(`${subject.workflowName}, step ${subject.label}: its live share leads could not be read, so whether it is refusing every lead is unknown: ${detail}`)
      keys.push(`${key}:unreadable`)
      unread++
      subjects.push({ workflow_id: subject.workflowId, namespace: subject.namespace, verdict: 'unmeasured', count: null, last_contact_at: null, windows_read: 0, detail })
      continue
    }
    const v = judgeRun(read.newestFirst)
    subjects.push({
      workflow_id: subject.workflowId,
      namespace: subject.namespace,
      verdict: v.verdict,
      count: v.count,
      last_contact_at: v.verdict === 'too_few' ? null : v.lastContactAt,
      windows_read: read.windows,
    })
    if (v.verdict === 'refusing') {
      lines.push(refusingLine(subject, v, deps.appUrl))
      // The same run is the same problem however long it grows; a new reason is a new one.
      keys.push(`${key}:${v.reasons.map((r) => `${r.partner ?? ''}/${r.reason}`).sort().join(',')}`)
    }
  }

  await deps.notify(lines, keys, remedyFor(lines.length - unread, unread))
  return { subjects, paged_lines: lines.length }
}

// ── Production wiring ─────────────────────────────────────────────────────────

/** Workflows are a dozen rows; read whole, past the row cap all the same. */
const WORKFLOW_PAGE_LIMIT = 20

export function productionLiveShareDeps(supabase: SupabaseClient, env: Env): LiveShareDeps {
  return {
    listSubjects: async () => {
      const rows = await fetchAllPaged<WorkflowRow>(
        (from, to) => supabase
          .from('workflows')
          .select('id, organization_id, name, is_active, definition')
          .eq('is_active', true)
          .is('deleted_at', null)
          .order('id', { ascending: true })
          .range(from, to),
        'workflows',
        { maxPages: WORKFLOW_PAGE_LIMIT },
      )
      return subjectsFromWorkflows(rows)
    },
    readLeads: async (subject, fromMs, toMs) => {
      const rows = await fetchAllPaged<LiveShareRow & { id: string }>(
        (from, to) => supabase
          .from('execution_steps')
          .select('id, started_at, sale:output->sale, considered:output->considered, reason:output->>reason')
          // workflow_id, step_namespace and started_at lead the index; started_at prunes the daily partitions.
          .eq('workflow_id', subject.workflowId)
          .eq('step_namespace', subject.namespace)
          .eq('step_type', 'buyer_select')
          .eq('is_test', false)
          .eq('output->>mode_effective', 'live')
          .in('output->>_route', ['sold', 'no_sale'])
          .gte('started_at', new Date(fromMs).toISOString())
          .lt('started_at', new Date(toMs).toISOString())
          .order('started_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
        'execution_steps live share',
      )
      const leads: LiveShareLead[] = []
      let unreadable = 0
      for (const row of rows) {
        const lead = leadFromRow(row)
        if (lead) leads.push(lead)
        else unreadable++
      }
      if (unreadable > 0) throw new Error(`${unreadable} of ${rows.length} live share rows carry no readable sale record`)
      return leads
    },
    notify: (lines, keys, remedy) => notifyExportFailure(supabase, LIVE_SHARE_REFUSALS_JOB, lines, env.IDEMPOTENCY, remedy, Date.now(), { keys }),
    now: () => Date.now(),
    localDev: Boolean(env.LOCAL_DEV),
    appUrl: env.APP_URL,
  }
}

function endingOf(s: LiveShareSummary): JobRunEnding {
  if (s.skipped) return { outcome: 'skipped', detail: s.skipped }
  const verdicts = s.subjects.map((x) => x.verdict)
  const outcome = verdicts.includes('refusing') ? 'findings' : verdicts.includes('unmeasured') || verdicts.includes('too_few') ? 'unmeasured' : 'ok'
  return { outcome, summary: { subjects: s.subjects, paged_lines: s.paged_lines } }
}

/** What the scheduled handler calls: the check under a job run record (L557). */
export function runLiveShareRefusalsForEnv(supabase: SupabaseClient, env: Env): Promise<LiveShareSummary> {
  return withJobRun(supabase, LIVE_SHARE_REFUSALS_JOB, () => runLiveShareRefusals(productionLiveShareDeps(supabase, env)), endingOf)
}
