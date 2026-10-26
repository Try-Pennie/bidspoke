/**
 * The page for "nobody can be told" (#2063; Dan's decision of 2026-10-16, option (a)).
 *
 * When a scheduled Slack lookup finds the database not answering AND no usable
 * saved Slack copy (`no_copy`, `org_not_in_copy`, `copy_unreadable`, the
 * `unreachable` results scheduled-slack.ts names), no Slack alert can be posted.
 * The worker's own log lines do not reach Better Stack either: log forwarding
 * was narrowed on 2026-09-09 to keep applicant data out (#1007, #1214), and
 * measured on 2026-10-16 bidspoke-worker is not in that stream at all. So the
 * worker sends ONE fixed line straight to a Better Stack HTTP log source, and a
 * Better Stack alert matching on that source pages. Neither the database nor
 * Slack is on that path.
 *
 * What it may send is fixed: the line, the organization id, the reason and a
 * timestamp, built in one place (`nobodyToldEvent`) and pinned whole by a test,
 * so no other field (a lead, an error detail that could quote one) can be added
 * without that test failing (L482).
 *
 * Cadence: at most once per organization per tick (in memory), and once sent, not
 * again for NOBODY_TOLD_TTL_SECONDS (a KV record), so a database that stays down
 * sends one line per organization per hour rather than one a minute. A send that
 * fails writes no record, so the next tick tries again.
 *
 * It never fails or delays its caller: `page` resolves in every case, bounded by
 * NOBODY_TOLD_PAGE_DEADLINE_MS for the send plus NOBODY_TOLD_KV_WRITE_DEADLINE_MS
 * for recording it, and the scheduled client hands it to waitUntil
 * rather than awaiting it.
 *
 * Inert until BETTERSTACK_OUTAGE_TOKEN and BETTERSTACK_OUTAGE_URL are set (the
 * source's token and its per-source ingesting host): it then says once per tick
 * that nothing was sent.
 *
 * `drillNobodyToldPage` sends one page on demand (#1303, the admin drill route)
 * through the same request, with `reason: 'drill'`, and touches no KV, so a
 * person can prove the secrets and the alert before an outage needs them.
 */
import type { CopyUnreachableReason } from './scheduled-slack'
import { raceDeadline } from './alert-claim'
import { formatErr } from './format-error'
import { betterStackTarget, postBetterStackEvent, sendBetterStackLine, type BetterStackSendOutcome } from './better-stack-line'

/**
 * The Better Stack alert that matches on NOBODY_TOLD_LINE. Created in Better
 * Stack by hand (docs/reference/observability.md) under the name Dan chose on
 * 2026-10-16; named here so a change to the line names the alert that must
 * change with it. The alert matches on the line, never on this name.
 */
export const BETTER_STACK_ALERT_NAME = 'Bidspoke Slack alerts down'

/** The one line the alert matches on, sent as the event's `message`. */
export const NOBODY_TOLD_LINE = 'bidspoke nobody can be told in Slack: the database did not answer and no saved Slack copy could stand in'

/** How long the send may take, dedupe KV read included. The record write after it has its own 1 s, so a page is bounded at 6 s. */
export const NOBODY_TOLD_PAGE_DEADLINE_MS = 5_000

/** How long the KV read that dedupes may take before the page is sent anyway. */
export const NOBODY_TOLD_KV_READ_DEADLINE_MS = 1_000

/** How long the KV record of an accepted page may take; outside the send's deadline, after it. */
export const NOBODY_TOLD_KV_WRITE_DEADLINE_MS = 1_000

/** How long a sent page holds off the next one for the same organization. */
export const NOBODY_TOLD_TTL_SECONDS = 3_600

/** The KV record of a sent page, in IDEMPOTENCY: this prefix plus the org id, or `all`. */
export const NOBODY_TOLD_KV_PREFIX = 'nobody-told-page:'

/**
 * Why a page was sent: one of the three ways the saved copy could not stand in,
 * or `drill`, a page sent on demand by POST /api/admin/nobody-told-page/drill
 * (#1303) to prove the source and the alert work. A scheduled tick never sends
 * `drill`; `page` takes only the three.
 */
export type NobodyToldReason = CopyUnreachableReason | 'drill'

/** The only fields a page carries. */
export interface NobodyToldEvent {
  message: typeof NOBODY_TOLD_LINE
  /** Null when the lookup was for every organization at once (the all-org list read), and for a drill. */
  organization_id: string | null
  reason: NobodyToldReason
  /** When the lookup failed, RFC 3339; Better Stack reads `dt` as the event time. */
  dt: string
}

/** The one place a page's body is built. */
export function nobodyToldEvent(orgId: string | null, reason: NobodyToldReason, nowMs: number): NobodyToldEvent {
  return { message: NOBODY_TOLD_LINE, organization_id: orgId, reason, dt: new Date(nowMs).toISOString() }
}

// The page and the drill both make the one shared request (better-stack-line.ts,
// #2364; a guard holds every Worker POST to the source there), so a drill proves
// exactly what an outage would send.

export interface NobodyToldKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

export interface NobodyToldPagerOptions {
  /** BETTERSTACK_OUTAGE_TOKEN: the HTTP source's token. */
  token: string | undefined
  /** BETTERSTACK_OUTAGE_URL: the source's ingesting host, as a URL. */
  url: string | undefined
  kv: NobodyToldKv
  fetch?: typeof fetch
  now?: () => number
  /** The timer seam, so no test waits for real (L524). */
  delay?: (ms: number) => Promise<void>
}

export interface NobodyToldPager {
  /** Page once for this organization (null for every organization). Always resolves. */
  page(orgId: string | null, reason: CopyUnreachableReason): Promise<void>
}

const realDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** One pager per tick: its memory of who was paged, and of having said it is inert, is that tick's. */
export function createNobodyToldPager(options: NobodyToldPagerOptions): NobodyToldPager {
  const fetchFn = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const delay = options.delay ?? realDelay
  const target = betterStackTarget(options.token, options.url)
  const handled = new Set<string>()
  let saidInert = false

  const send = async (key: string, orgId: string | null, reason: CopyUnreachableReason, signal: AbortSignal): Promise<'sent' | 'already'> => {
    const recordKey = `${NOBODY_TOLD_KV_PREFIX}${key}`
    // Paging matters more than a repeat: a KV read that fails or hangs sends anyway.
    const prior = await raceDeadline(() => options.kv.get(recordKey), NOBODY_TOLD_KV_READ_DEADLINE_MS, delay)
    if (prior.kind === 'ok' && prior.value !== null) return 'already'
    if (prior.kind !== 'ok') {
      console.warn(`[nobody-told-page] could not read whether ${key} was already paged (${prior.kind === 'threw' ? formatErr(prior.error) : `no answer in ${NOBODY_TOLD_KV_READ_DEADLINE_MS} ms`}), so it is paged anyway`)
    }
    const res = await postBetterStackEvent(fetchFn, target, nobodyToldEvent(orgId, reason, now()), signal)
    if (!res.ok) throw new Error(`Better Stack answered ${res.status}`)
    return 'sent'
  }

  /**
   * The record of a sent page, OUTSIDE the send's deadline: once Better Stack has
   * accepted the page, a KV write that hangs or fails is a page sent but not
   * recorded, never a send that got no answer (lessons review of #2259).
   */
  const record = async (key: string): Promise<void> => {
    const wrote = await raceDeadline(
      () => options.kv.put(`${NOBODY_TOLD_KV_PREFIX}${key}`, String(now()), { expirationTtl: NOBODY_TOLD_TTL_SECONDS }),
      NOBODY_TOLD_KV_WRITE_DEADLINE_MS,
      delay,
    )
    if (wrote.kind === 'ok') return
    const why = wrote.kind === 'threw' ? formatErr(wrote.error) : `no answer in ${NOBODY_TOLD_KV_WRITE_DEADLINE_MS} ms`
    console.error(`[nobody-told-page] paged for ${key}, but the page could not be recorded (${why}), so the next tick may page again`)
  }

  return {
    async page(orgId, reason) {
      const key = orgId ?? 'all'
      if (handled.has(key)) return
      handled.add(key)
      if (target.missing.length > 0) {
        if (!saidInert) {
          saidInert = true
          console.warn('[nobody-told-page] BETTERSTACK_OUTAGE_TOKEN or BETTERSTACK_OUTAGE_URL is unset, so nobody is paged in Better Stack this tick')
        }
        return
      }
      try {
        const stop = new AbortController()
        const outcome = await raceDeadline(() => send(key, orgId, reason, stop.signal), NOBODY_TOLD_PAGE_DEADLINE_MS, delay)
        if (outcome.kind === 'timed_out') {
          stop.abort()
          console.error(`[nobody-told-page] page for ${key} (${reason}) got no answer in ${NOBODY_TOLD_PAGE_DEADLINE_MS} ms, so it was given up and the next tick tries again`)
        } else if (outcome.kind === 'threw') {
          console.error(`[nobody-told-page] page for ${key} (${reason}) failed: ${formatErr(outcome.error)}; the next tick tries again`)
        } else if (outcome.value === 'already') {
          console.log(`[nobody-told-page] ${key} was already paged in this outage, so nothing was sent`)
        } else {
          console.warn(`[nobody-told-page] paged Better Stack for ${key} (${reason})`)
          await record(key)
        }
      } catch (e) {
        // raceDeadline folds every failure into a value; this is only for a log call throwing.
        console.error(`[nobody-told-page] page for ${key} failed outside the send: ${formatErr(e)}`)
      }
    },
  }
}

/** What a drill came to, as POST /api/admin/nobody-told-page/drill answers it. */
export type NobodyToldDrillOutcome = BetterStackSendOutcome

/** The pager's options without KV: a drill has no record to read or write. */
export type NobodyToldDrillOptions = Omit<NobodyToldPagerOptions, 'kv'>

/**
 * Sends ONE drill page (#1303), through the same request and deadline as a real
 * page, and answers what happened. It takes no KV on purpose: the real page
 * dedupes on `nobody-told-page:all`, the very key a drill's null organization
 * would land on, so a drill that recorded itself would hold back a real
 * outage's page for an hour as already sent. With no KV it can neither suppress
 * a real page nor be suppressed by one.
 */
export async function drillNobodyToldPage(options: NobodyToldDrillOptions): Promise<NobodyToldDrillOutcome> {
  const now = options.now ?? Date.now
  return sendBetterStackLine(options, nobodyToldEvent(null, 'drill', now()), NOBODY_TOLD_PAGE_DEADLINE_MS)
}
