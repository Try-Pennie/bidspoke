/**
 * The stored copy alerts (#1848), run every minute right after the stored copy
 * sweep:
 *
 * 1. **Leads are being served from stored copies.** Read from the stored copy
 *    ledger (stored-copy-ledger.ts), which every loader adds to when it serves or
 *    refuses a copy. This is the outage alert, so it must reach Slack while the
 *    database is down: the Slack connections come through the scheduled client's
 *    bounded read, which asks the database once under a 3 s deadline and answers
 *    from the encrypted last-good copy the database probe (database-reachability.ts) rewrites every minute
 *    (`slack-conns-lastgood`) when it does not answer (#1303, L71). It pages once per
 *    stretch on the shared reminder schedule, at once again when copies start
 *    being refused, and posts an all-clear once none has been used for the
 *    re-arm window.
 *
 * 2. **A stored copy has gone stale.** Every copy a live lead could need is read
 *    and judged with the one age rule (judgeCopyAge): a copy past the 30 minute
 *    maximum, or with no readable time, would be refused if the database failed
 *    now, so it has silently stopped protecting anything.
 *
 * 3. **The stored copy sweep keeps failing.** A copy an edit could not clear is
 *    repaired only by the sweep (#1846), and copies no lead reads are confirmed
 *    only by it, so a sweep that has failed on every run for a whole
 *    confirmation interval is paged with what it could not do.
 *
 * The second and third wait while stored copies are in use at all: copies age
 * and the sweep fails then because the database is down, which the first
 * already says (L36, one page per outage rather than three). They go through
 * the shared alerter (notifyExportFailure), so they are muted, reminded and
 * cleared like every other scheduled check: `export-alert:stored-copy-stale`
 * and `export-alert:stored-copy-sweep`. The first is muted by writing
 * `stored-copy-serving:cooldown` in the IDEMPOTENCY namespace.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { readStoredCopyLedger, type LedgerKv, type LedgerReading } from './stored-copy-ledger'
import {
  COPY_LABELS,
  STORED_COPY_MAX_AGE_MS,
  STORED_COPY_RECONFIRM_AFTER_MS,
  judgeCopyAge,
  readConfirmedCopy,
  type StoredCopyKind,
  type StoredCopyRefusal,
} from './stored-copy-age'
import { ENDPOINT_PREFIX, MATRIX_PREFIX, PARTNER_PREFIX, WORKFLOW_PREFIX, listKeys, matrixCopyOf, type SweepResult } from './stored-copy-sweep'
import { envVarsLastGoodKey } from './env-loader'
import { partnerConstantsLastGoodKey } from './partner-constants-loader'
import { buyerProfilesLastGoodKey } from './buyer-profile-loader'
import { notifyExportFailure } from './export-alerts'
import { ALERT_CLAIM_TTL_SECONDS } from './volume-cliff'
import { readEverySlackConnection } from './alert-fanout'
import { etTime, sendRecoveryAlert, sendTitledAlert } from './slack'
import { backoffCooldownKey, clearCondition, describeRepeat, fingerprintAlert, inCooldown, nextFingerprint, readCondition, recordAlert, recurrenceOf, type BackoffKv } from './alert-backoff'
import { keepAlerted, markSpikeSeen, recordPaged, recoveryDue, settleRecovery, type IncidentContext, type RecoveryKv } from './alert-recovery'
import type { AlertClaims } from './alert-claim'
import { formatErr } from './format-error'

/** The minutes, ending with the current one, the serving alert looks back over. */
export const STORED_COPY_SERVING_WINDOW_MINUTES = 5

/**
 * How many of those minutes must have used a stored copy before it pages.
 * Measured 2026-10-07 from Workers Logs: in the two and a half healthy hours
 * after the lead read deadline shipped, two reads missed it (both custom
 * endpoint lookups, half an hour apart), each in a minute of its own. At that
 * rate copies in two minutes of five would page about daily, three about
 * monthly, and an outage uses them every minute, so it pages within three.
 */
export const STORED_COPY_SERVING_ALERT_MINUTES = 3

/**
 * How long the sweep must have failed on every run before it pages: one
 * confirmation interval, after which every copy no lead reads has missed a
 * confirmation it was due, and a single retry has had five chances. It leaves
 * well over half the maximum age before such a copy is refused.
 */
export const SWEEP_FAILING_ALERT_AFTER_MS = STORED_COPY_RECONFIRM_AFTER_MS

/** The serving alert's claim, standing condition (`:condition`, `:cooldown`) and recovery family. */
export const STORED_COPY_SERVING_KEY = 'stored-copy-serving'
const SERVING_SUBJECT = 'all'

export const STORED_COPY_STALE_JOB = 'stored-copy-stale'
export const STORED_COPY_SWEEP_JOB = 'stored-copy-sweep'

/** When the sweep first failed in its current stretch of failures. */
export const SWEEP_FAILING_SINCE_KEY = 'stored-copy-sweep:failing-since'
/** Outlives any stretch the alert speaks about; a clean run deletes it long before. */
const SWEEP_FAILING_SINCE_TTL_SECONDS = 7 * 24 * 60 * 60

const MINUTE_MS = 60_000
const MAX_AGE_MINUTES = STORED_COPY_MAX_AGE_MS / MINUTE_MS

type CheckKv = LedgerKv & BackoffKv & RecoveryKv

type SlackTarget = { bot_token: string; default_channel: string }

export interface TitledMessage {
  title: string
  errors: string[]
  context?: string
  fixHint?: string
  repeat?: string
}

export interface StoredCopyCheckDeps {
  /** IDEMPOTENCY: the ledger and alert state. */
  kv: CheckKv
  /** WORKFLOW_CACHE: the stored copies themselves. */
  copies: KVNamespace
  /** The scheduled handler's client, whose Slack reads fall back to the last-good copy (#1303). */
  supabase: SupabaseClient
  claims?: AlertClaims
  appUrl: string
  /** What this minute's sweep reported. */
  sweep: SweepResult
  now?: () => number
  /** Seams for tests; production uses the real senders and the shared alerter. */
  post?: (slack: SlackTarget, message: TitledMessage) => Promise<boolean>
  postRecovery?: typeof sendRecoveryAlert
  notify?: typeof notifyExportFailure
}

export type ServingOutcome = 'posted' | 'cooldown' | 'claimed_elsewhere' | 'no_slack' | 'post_failed' | 'below_threshold' | 'quiet' | 'recovered' | 'unmeasured'

export interface StoredCopyCheckResult {
  serving: ServingOutcome
  /** Minutes in the window that used a stored copy, or null when the ledger could not be read. */
  activeMinutes: number | null
  /** True when the stale and sweep alerts waited because copies were in use. */
  suppressed: boolean
  stale: number
  sweepFailingSince: string | null
  /** Incident record writes that failed this run (#2099); the alerts themselves went ahead. */
  recordErrors: string[]
}

export async function runStoredCopyChecks(deps: StoredCopyCheckDeps): Promise<StoredCopyCheckResult> {
  const now = deps.now ?? Date.now
  const nowMs = now()

  let reading: LedgerReading | null = null
  try {
    reading = await readStoredCopyLedger(deps.kv, nowMs, STORED_COPY_SERVING_WINDOW_MINUTES)
  } catch (e) {
    console.error(`[stored-copy-checks] could not read the stored copy ledger, so whether copies are being served is unmeasured this minute: ${formatErr(e)}`)
  }

  let serving: ServingOutcome = 'unmeasured'
  const recordErrors: string[] = []
  if (reading) {
    try {
      serving = await reportServing(deps, reading, nowMs, recordErrors)
    } catch (e) {
      console.error(`[stored-copy-checks] the serving alert failed: ${formatErr(e)}`)
      serving = 'post_failed'
    }
  }

  // Independent of the serving alert's own outcome, each in its own boundary.
  const suppressed = reading !== null && reading.activeMinutes > 0
  let failingSince: number | null = null
  try {
    failingSince = await recordSweepOutcome(deps.kv, deps.sweep, nowMs)
  } catch (e) {
    console.error(`[stored-copy-checks] could not record the sweep outcome: ${formatErr(e)}`)
  }
  const notify = deps.notify ?? notifyExportFailure
  let staleCount = 0
  if (!suppressed) {
    try {
      await reportSweep(deps, notify, failingSince, nowMs)
    } catch (e) {
      console.error(`[stored-copy-checks] the sweep alert failed: ${formatErr(e)}`)
    }
    try {
      staleCount = await reportStale(deps, notify, nowMs)
    } catch (e) {
      console.error(`[stored-copy-checks] the stale copy alert failed: ${formatErr(e)}`)
    }
  }

  return {
    serving,
    activeMinutes: reading?.activeMinutes ?? null,
    suppressed,
    stale: staleCount,
    sweepFailingSince: failingSince === null ? null : new Date(failingSince).toISOString(),
    recordErrors,
  }
}

// ── 1. Leads served from stored copies ───────────────────────────────────────

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const times = (n: number) => `${n} time${n === 1 ? '' : 's'}`
const minutesWord = (ms: number) => {
  const m = Math.floor(ms / MINUTE_MS)
  return m === 1 ? '1 minute' : `${m} minutes`
}

const REFUSAL_WORDS: Record<StoredCopyRefusal, string> = {
  copy_too_old: `the stored copy was past the ${MAX_AGE_MINUTES} minute limit`,
  no_copy: 'there was no stored copy',
  copy_age_unknown: 'the stored copy carried no readable time',
  copy_unusable: 'the stored copy could not be read or was not fit to serve',
}

/** The copies whose labels are plural, for the verb that follows them. */
const PLURAL_LABELS: ReadonlySet<StoredCopyKind> = new Set(['env_vars', 'partner_constants', 'buyer_profiles'])

/** The order kinds are listed in the alert, keyed by the type so a new kind cannot be left out of it. */
const KIND_RANK: Record<StoredCopyKind, number> = { workflow_definition: 0, custom_endpoint: 1, env_vars: 2, partner_constants: 3, partner_config: 4, buyer_profiles: 5, bid_matrix: 6 }
const KIND_ORDER = (Object.keys(KIND_RANK) as StoredCopyKind[]).sort((a, b) => KIND_RANK[a] - KIND_RANK[b])

/** The alert's words, from what the ledger measured and nothing more. */
export function servingMessage(reading: LedgerReading): TitledMessage & { refusing: boolean } {
  const lines: string[] = [
    // Any failed read serves a copy, not only a slow one (#835).
    `A database read failed or timed out in ${reading.activeMinutes} of the last ${STORED_COPY_SERVING_WINDOW_MINUTES} minutes, so Bidspoke used its stored copies in its place.`,
  ]
  let refusing = false
  for (const kind of KIND_ORDER) {
    const t = reading.kinds[kind]
    if (!t) continue
    const label = cap(COPY_LABELS[kind])
    const verb = PLURAL_LABELS.has(kind) ? 'were' : 'was'
    if (t.served > 0) {
      const oldest = t.oldestServedAgeMs === null ? '' : `; the oldest was last confirmed ${minutesWord(t.oldestServedAgeMs)} ago`
      lines.push(`${label} ${verb} served from a stored copy at least ${times(t.served)}${oldest}.`)
    }
    // REFUSAL_WORDS is keyed by the type and written in the order the alert lists them.
    for (const reason of Object.keys(REFUSAL_WORDS) as StoredCopyRefusal[]) {
      const n = t.refused[reason]
      if (n === 0) continue
      refusing = true
      lines.push(`${label} ${verb} refused at least ${times(n)} because ${REFUSAL_WORDS[reason]}.`)
    }
  }
  return {
    title: refusing ? 'Leads are being refused: stored copies are past their limit or missing' : 'Leads are being served from stored copies',
    errors: lines,
    context: `Each stored copy is refused ${MAX_AGE_MINUTES} minutes after it was last confirmed, so leads start failing if the database stays down that long.`,
    fixHint: 'check status.supabase.com and the project\'s database health in the Supabase dashboard. Nothing on the worker needs restarting, and an all-clear follows here once no copy has been used for 30 minutes.',
    refusing,
  }
}

/**
 * Where the serving alert goes: every org's Slack connection with volume alerts
 * on (the toggle the database unreachable alert also follows), through the one
 * bounded read the scheduled client shares (readEverySlackConnection, #1303):
 * the database under a 3 s deadline, the last-good copy when it does not answer,
 * which is exactly when this alert speaks. The read logs why when nobody can be told.
 */
async function servingAlertTargets(supabase: SupabaseClient): Promise<SlackTarget[]> {
  // Tell-only: the finding is the stored copy ledger in KV (#1303).
  const read = await readEverySlackConnection(supabase, 'stored-copy-checks', 'tell-only')
  if (read.kind === 'unreachable') return []
  return [...read.connections.values()].filter((c) => c.volume_alerts_enabled)
}

async function reportServing(deps: StoredCopyCheckDeps, reading: LedgerReading, nowMs: number, recordErrors: string[]): Promise<ServingOutcome> {
  const { kv } = deps
  // Leads served from copies is everyone's problem, so the incident is the platform's,
  // recorded to the KV outbox because the database is what is failing (#2099).
  const incident: IncidentContext = {
    scope: { kind: 'platform' },
    subjectLabel: 'Stored copy use',
    onRecordError: (message) => recordErrors.push(message),
  }
  const post = deps.post ?? ((slack: SlackTarget, message: TitledMessage) => sendTitledAlert(slack, null, message))

  if (reading.activeMinutes < STORED_COPY_SERVING_ALERT_MINUTES) {
    // Below the threshold is not over: a copy used at all in the window moves
    // the incident's running end, so the all-clear waits the re-arm window from
    // the last use rather than from the last tick that met the threshold.
    if (reading.lastActiveMs !== null) await markSpikeSeen(kv, STORED_COPY_SERVING_KEY, SERVING_SUBJECT, reading.lastActiveMs)
    const due = await recoveryDue(kv, STORED_COPY_SERVING_KEY, SERVING_SUBJECT, { now: nowMs })
    if (!due) return reading.activeMinutes > 0 ? 'below_threshold' : 'quiet'
    const targets = await servingAlertTargets(deps.supabase)
    const send = deps.postRecovery ?? sendRecoveryAlert
    let delivered = false
    for (const slack of targets) {
      const ok = await send(slack, slack.default_channel, {
        signal: 'stored copy',
        subject: 'Stored copy use',
        recoveredPhrase: 'has stopped',
        alertedAt: due.alertedAt,
        endedAt: due.endedAt,
        // due.firstHealthyAt is deliberately not passed (#2580): this check asks
        // recoveryDue on a tick that still saw a copy used below the threshold,
        // which is not over, so the tick it records is not one that found the
        // condition clear. The notice says it had cleared by this tick instead.
        measuredWindowMinutes: STORED_COPY_SERVING_WINDOW_MINUTES,
        url: `${deps.appUrl}/dashboard`,
      }, nowMs).catch((e: unknown) => {
        console.error(`[stored-copy-checks] all-clear failed: ${formatErr(e)}`)
        return false
      })
      if (ok) delivered = true
    }
    if (!delivered) return reading.activeMinutes > 0 ? 'below_threshold' : 'quiet'
    await settleRecovery(kv, STORED_COPY_SERVING_KEY, SERVING_SUBJECT, backoffCooldownKey(STORED_COPY_SERVING_KEY), { ...incident, reason: 'all_clear' }, nowMs)
    await clearCondition(kv, STORED_COPY_SERVING_KEY)
    return 'recovered'
  }

  // The condition stands: record its running end on every tick, whether or not it posts.
  await markSpikeSeen(kv, STORED_COPY_SERVING_KEY, SERVING_SUBJECT, nowMs)
  const standing = await readCondition(kv, STORED_COPY_SERVING_KEY)
  if (standing) await keepAlerted(kv, STORED_COPY_SERVING_KEY, SERVING_SUBJECT, standing.since, incident, nowMs)

  const message = servingMessage(reading)
  // Serving and refusing are the two problems; every count and age is a detail,
  // so a growing count is a reminder, and refusals starting is new at once.
  const print = await fingerprintAlert({
    title: STORED_COPY_SERVING_KEY,
    findings: message.refusing ? ['serving', 'refusing'] : ['serving'],
    keys: message.refusing ? ['serving', 'refusing'] : ['serving'],
    alsoShown: message.errors,
  })
  const recurrence = recurrenceOf(standing, print)
  const different = recurrence.kind === 'new' && standing !== null
  if (!different && (await inCooldown(kv, STORED_COPY_SERVING_KEY))) return 'cooldown'

  if (deps.claims && !(await deps.claims.claim(STORED_COPY_SERVING_KEY, ALERT_CLAIM_TTL_SECONDS))) return 'claimed_elsewhere'
  const release = async () => {
    if (deps.claims) await deps.claims.release(STORED_COPY_SERVING_KEY)
  }

  const targets = await servingAlertTargets(deps.supabase)
  if (targets.length === 0) {
    await release()
    return 'no_slack'
  }
  const reminderOf = recurrence.kind === 'reminder' ? recurrence.standing : null
  const repeat = describeRepeat(reminderOf, nowMs, recurrence.kind === 'reminder' && recurrence.unchanged) ?? undefined
  let delivered = false
  for (const slack of targets) {
    const ok = await post(slack, { title: message.title, errors: message.errors, context: message.context, fixHint: message.fixHint, repeat }).catch((e: unknown) => {
      console.error(`[stored-copy-checks] Slack post failed: ${formatErr(e)}`)
      return false
    })
    if (ok) delivered = true
  }
  if (!delivered) {
    await release()
    return 'post_failed'
  }
  const next = await recordAlert(kv, STORED_COPY_SERVING_KEY, reminderOf, nowMs, { fingerprint: nextFingerprint(standing, print) })
  await keepAlerted(kv, STORED_COPY_SERVING_KEY, SERVING_SUBJECT, next.since, incident, nowMs)
  await recordPaged(kv, STORED_COPY_SERVING_KEY, SERVING_SUBJECT, incident, nowMs)
  return 'posted'
}

// ── 2. Stale copies ──────────────────────────────────────────────────────────

export interface StaleCopy {
  copy: StoredCopyKind
  /** The KV key, which is what identifies the problem across runs. */
  key: string
  /** What it is a copy of, as a reader knows it. */
  subject: string
  reason: 'copy_too_old' | 'copy_age_unknown'
  ageMs: number | null
}

interface WorkflowCopyShape {
  is_active?: unknown
  unverified?: unknown
  written_at?: unknown
  workflow?: { workflow_name?: unknown; org_id?: unknown } | null
}

/**
 * Every stored copy a live lead could be served that is past the maximum age
 * or carries no readable time. Judged with judgeCopyAge, the rule the loaders
 * serve by, so this says exactly what an outage would refuse.
 *
 * Judged: every endpoint and partner copy (the sweep confirms or clears each
 * one), every live workflow definition copy, and the organization copies of
 * each organization a live workflow copy names. Not judged: a workflow
 * tombstone or an unverified copy, which refuse whatever their age, and an
 * organization no live workflow names, which no lead reaches. A kind KV could
 * not read is named in `unmeasured`, never read as fresh.
 */
export async function findStaleCopies(copies: KVNamespace, nowMs: number): Promise<{ stale: StaleCopy[]; unmeasured: string[] }> {
  const stale: StaleCopy[] = []
  const unmeasured: string[] = []
  const judge = (copy: StoredCopyKind, key: string, subject: string, confirmed: unknown) => {
    const verdict = judgeCopyAge(confirmed, nowMs)
    if (!verdict.usable) stale.push({ copy, key, subject, reason: verdict.reason, ageMs: verdict.ageMs })
  }
  const kind = async (name: string, work: () => Promise<void>) => {
    try {
      await work()
    } catch (e) {
      unmeasured.push(`${name}: ${formatErr(e)}`)
    }
  }

  await kind('endpoint copies', async () => {
    for (const key of await listKeys(copies, ENDPOINT_PREFIX)) {
      const held = await readConfirmedCopy(copies, key)
      if (held) judge('custom_endpoint', key, key.slice(ENDPOINT_PREFIX.length).replace(':', ''), held.confirmedAt)
    }
  })

  await kind('partner copies', async () => {
    for (const key of await listKeys(copies, PARTNER_PREFIX)) {
      const held = await readConfirmedCopy(copies, key)
      if (!held) continue
      let slug: unknown
      try {
        slug = (JSON.parse(held.value) as { slug?: unknown }).slug
      } catch {
        slug = undefined
      }
      judge('partner_config', key, typeof slug === 'string' && slug !== '' ? slug : key.slice(PARTNER_PREFIX.length), held.confirmedAt)
    }
  })

  await kind('bid matrix copies', async () => {
    for (const key of await listKeys(copies, MATRIX_PREFIX)) {
      const which = matrixCopyOf(key)
      const held = await readConfirmedCopy(copies, key)
      if (held) judge('bid_matrix', key, which ? `${which.configId} (${which.sellOff ? 'sell off' : 'offer'})` : key.slice(MATRIX_PREFIX.length), held.confirmedAt)
    }
  })

  const orgs = new Set<string>()
  let workflowsRead = false
  await kind('workflow definition copies', async () => {
    for (const key of await listKeys(copies, WORKFLOW_PREFIX)) {
      let copy: WorkflowCopyShape | null
      try {
        copy = await copies.get<WorkflowCopyShape>(key, 'json')
      } catch (e) {
        // Not read is not fresh (L215): named, and the rest still judged.
        unmeasured.push(`${key}: ${formatErr(e)}`)
        continue
      }
      if (!copy || copy.is_active !== true || copy.unverified === true) continue
      const name = copy.workflow?.workflow_name
      judge('workflow_definition', key, typeof name === 'string' && name !== '' ? name : key.slice(WORKFLOW_PREFIX.length), copy.written_at)
      if (typeof copy.workflow?.org_id === 'string') orgs.add(copy.workflow.org_id)
    }
    workflowsRead = true
  })
  if (!workflowsRead) unmeasured.push('organization copies: the live workflows that name them could not be read')

  for (const org of [...orgs].sort()) {
    await kind(`organization ${org} copies`, async () => {
      // The workflow scoped environment copy is written with the org copy and
      // the same stamp, so the org copy speaks for both.
      const env = await readConfirmedCopy(copies, envVarsLastGoodKey(org))
      if (env) judge('env_vars', envVarsLastGoodKey(org), org, env.confirmedAt)
      const constants = await readConfirmedCopy(copies, partnerConstantsLastGoodKey(org))
      if (constants) judge('partner_constants', partnerConstantsLastGoodKey(org), org, constants.confirmedAt)
      const buyers = await copies.get<{ loaded_at?: unknown }>(buyerProfilesLastGoodKey(org), 'json')
      if (buyers) judge('buyer_profiles', buyerProfilesLastGoodKey(org), org, buyers.loaded_at)
    })
  }

  return { stale, unmeasured }
}

/**
 * Where the job that confirms each copy logs why it could not (#835). The fix
 * used to say "search for prewarm and stored-copy-sweep", but the prewarm
 * swallows its loaders' errors and each loader logs under its own tag, so that
 * search found nothing for most copies. `prewarm` marks the copies the per
 * minute prewarm confirms, whose own failure to list the live workflows logs
 * under [prewarm]. Each tag is the exact text to search for: the definition
 * loader writes JSON events rather than a bracketed tag, and every one of its
 * copy events begins `workflow_definition_copy_` (logEvent in
 * engine/definition-loader.ts).
 */
const CONFIRMED_BY: Readonly<Record<StoredCopyKind, { tag: string; prewarm: boolean }>> = {
  workflow_definition: { tag: 'workflow_definition_copy_', prewarm: true },
  custom_endpoint: { tag: '[stored-copy-sweep]', prewarm: false },
  partner_config: { tag: '[stored-copy-sweep]', prewarm: false },
  bid_matrix: { tag: '[stored-copy-sweep]', prewarm: false },
  env_vars: { tag: '[env-loader]', prewarm: true },
  partner_constants: { tag: '[partner-constants]', prewarm: true },
  buyer_profiles: { tag: '[buyer-profiles]', prewarm: true },
}

/** The stale alert's fix line, naming the log tags of the jobs that confirm the copies listed. */
export function staleCopyFix(kinds: readonly StoredCopyKind[]): string {
  const present = KIND_ORDER.filter((k) => kinds.includes(k))
  const tags = [...new Set(present.map((k) => CONFIRMED_BY[k].tag))]
  if (present.some((k) => CONFIRMED_BY[k].prewarm)) tags.push('[prewarm]')
  return `search the worker logs for ${tags.map((t) => `\`${t}\``).join(', ')}, where the jobs that confirm these copies say why they could not. This clears on the first run that confirms them.`
}

export function describeStaleCopy(s: StaleCopy): string {
  const what = `The stored copy of ${COPY_LABELS[s.copy]} for ${s.subject}`
  if (s.reason === 'copy_age_unknown' || s.ageMs === null) return `${what} carries no readable confirmation time.`
  return `${what} was last confirmed ${minutesWord(s.ageMs)} ago, past the ${MAX_AGE_MINUTES} minute limit.`
}

async function reportStale(deps: StoredCopyCheckDeps, notify: typeof notifyExportFailure, nowMs: number): Promise<number> {
  const { stale, unmeasured } = await findStaleCopies(deps.copies, nowMs)
  for (const u of unmeasured) console.error(`[stored-copy-checks] could not judge ${u}`)
  // Silence about copies nobody could read is not health, so it clears nothing.
  // A KV that keeps refusing also fails the sweep, which pages on its own.
  if (stale.length === 0 && unmeasured.length > 0) return 0
  await notify(deps.supabase, STORED_COPY_STALE_JOB, stale.map(describeStaleCopy), deps.kv, {
    title: 'Stored copies have gone stale',
    context: 'If the database fails now, leads that need these copies are refused rather than served.',
    fixHint: staleCopyFix(stale.map((s) => s.copy)),
  }, nowMs, { keys: stale.map((s) => s.key) })
  return stale.length
}

// ── 3. A sweep that keeps failing ────────────────────────────────────────────

/**
 * Records this run of the sweep and returns when its current stretch of
 * failures began, or null after a clean run. A sweep that threw counts as one
 * that failed. One KV read on a healthy minute.
 */
export async function recordSweepOutcome(kv: Pick<BackoffKv, 'get' | 'put' | 'delete'>, sweep: SweepResult, nowMs: number): Promise<number | null> {
  const held = await kv.get(SWEEP_FAILING_SINCE_KEY)
  if (sweep.failed.length === 0) {
    if (held !== null) await kv.delete(SWEEP_FAILING_SINCE_KEY)
    return null
  }
  const since = held === null ? Number.NaN : Number(held)
  if (Number.isFinite(since) && since <= nowMs) return since
  await kv.put(SWEEP_FAILING_SINCE_KEY, String(nowMs), { expirationTtl: SWEEP_FAILING_SINCE_TTL_SECONDS })
  return nowMs
}

/** What a failure entry is about: the copy key or the kind of copy, before its error. */
const failureSubject = (entry: string) => {
  const cut = entry.indexOf(': ')
  return cut < 0 ? entry : entry.slice(0, cut)
}

async function reportSweep(deps: StoredCopyCheckDeps, notify: typeof notifyExportFailure, failingSince: number | null, nowMs: number): Promise<void> {
  const standing = failingSince !== null && nowMs - failingSince >= SWEEP_FAILING_ALERT_AFTER_MS
  const failures = standing ? deps.sweep.failed : []
  await notify(deps.supabase, STORED_COPY_SWEEP_JOB, failures.map((f) => `The sweep could not repair or confirm ${f.replace(/\.$/, '')}.`), deps.kv, {
    title: 'The stored copy sweep keeps failing',
    context: `It has failed on every run since ${failingSince === null ? 'an unknown time' : etTime(failingSince)}. Until it succeeds, a copy an edit could not clear can still be served in an outage, and copies no lead reads stop being confirmed and are refused ${MAX_AGE_MINUTES} minutes after their last confirmation.`,
    fixHint: 'find the error above in the worker logs (search for stored-copy-sweep). The sweep runs every minute and this clears on its first clean run.',
  }, nowMs, { keys: failures.map(failureSubject) })
}
