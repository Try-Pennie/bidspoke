/**
 * Listing the alerts that are currently suppressed, and when they return (#1047).
 *
 * An alert that pages through the shared export alerter (notifyExportFailure)
 * stays quiet while its `:cooldown` key is set in KV. So a condition that is
 * standing and a condition that someone MUTED by hand both read, from the Slack
 * channel, as the same thing: silence. Nothing anywhere said that such a silence
 * existed or when it lifts, which is the failure this codebase guards against
 * elsewhere (L98, L557): a deliberate silence is indistinguishable from a
 * healthy system, and a mute written without a TTL is silent for ever with
 * nothing to reveal it. On 2026-08-24 seven archive alerts were muted by hand
 * for ten days and only the person who set them knew.
 *
 * This reads, strictly read-only, every `export-alert:<job>:cooldown` key in the
 * IDEMPOTENCY namespace, pairs each with its standing-condition record, and says
 * which job is muted, when the suppression lifts (the KV expiry), and how long
 * the condition has stood.
 *
 * Scope: the `export-alert:` family only. That is the family every scheduled
 * check and every archive alert pages through (the archive alerts muted by
 * hand among them), and the one the alert-lifecycle milestone is consolidating onto. Other
 * families key their cooldowns under their own names and are not listed here;
 * widening the scope means mapping each of those keys back to a human condition
 * name, which is a separate change.
 */
import { readCondition, type BackoffKv } from './alert-backoff'

/** The family prefix every export and scheduled-check alert keys its cooldown under. */
export const EXPORT_ALERT_PREFIX = 'export-alert:'
const COOLDOWN_SUFFIX = ':cooldown'

export interface MutedAlert {
  /** The alert-backoff family key, e.g. `export-alert:Archive ingest`. */
  familyKey: string
  /** The job name the alert reports under, e.g. `Archive ingest`. */
  jobName: string
  /**
   * When the suppression lifts, as an ISO instant, or null when the cooldown
   * key carries no expiry. A null is the dangerous case the issue names: a mute
   * that never lifts on its own. It is reported first and said plainly.
   */
  returnsAt: string | null
  /** Seconds until the suppression lifts, or null when there is no expiry. */
  secondsRemaining: number | null
  /** ISO instant of the first alert in this stretch, when a condition is on record. */
  standingSince: string | null
  /** How many alerts have been posted for this occurrence, when a condition is on record. */
  reminders: number | null
}

/** Just the reads this needs: `get` (for the condition record) and `list`. */
interface MutedAlertsKv extends BackoffKv {
  list(opts: { prefix: string; cursor?: string }): Promise<KVNamespaceListResult<unknown>>
}

/**
 * How many condition records to read at once.
 *
 * The number of cooldown keys is bounded by the finite set of `export-alert:`
 * job names in the code (a few dozen, not something runtime traffic can grow),
 * so the total KV reads here stay far below a Worker invocation's subrequest
 * ceiling. This cap is belt and braces: even a KV left holding more stray keys
 * than expected cannot fire hundreds of `get`s simultaneously, which is what a
 * bare `Promise.all` over every key would do.
 */
const CONDITION_READ_CONCURRENCY = 10

/**
 * Every export-alert condition whose cooldown is currently set, soonest-to-lift
 * first with the no-expiry mutes leading.
 *
 * It does NOT catch a KV list failure. Returning an empty list on an error would
 * read as "nothing is muted", which is the healthy state and the exact silence
 * this feature exists to make legible (L98), so the failure propagates and the
 * caller reports it could not read rather than that all is well. The
 * per-condition `readCondition` already treats a damaged record as unknown (it
 * returns null), which only loses the "standing since" enrichment, never the
 * core fact that the job is muted.
 */
export async function listMutedAlerts(kv: MutedAlertsKv, nowMs: number = Date.now()): Promise<MutedAlert[]> {
  const nowSeconds = Math.floor(nowMs / 1000)

  const cooldowns: { familyKey: string; expiration: number | null }[] = []
  let cursor: string | undefined
  do {
    const page = await kv.list({ prefix: EXPORT_ALERT_PREFIX, cursor })
    for (const key of page.keys) {
      if (!key.name.endsWith(COOLDOWN_SUFFIX)) continue
      cooldowns.push({
        familyKey: key.name.slice(0, -COOLDOWN_SUFFIX.length),
        expiration: typeof key.expiration === 'number' ? key.expiration : null,
      })
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)

  const muted: MutedAlert[] = []
  for (let i = 0; i < cooldowns.length; i += CONDITION_READ_CONCURRENCY) {
    const batch = await Promise.all(
      cooldowns.slice(i, i + CONDITION_READ_CONCURRENCY).map(async ({ familyKey, expiration }): Promise<MutedAlert> => {
        const condition = await readCondition(kv, familyKey)
        return {
          familyKey,
          jobName: familyKey.slice(EXPORT_ALERT_PREFIX.length),
          returnsAt: expiration === null ? null : new Date(expiration * 1000).toISOString(),
          secondsRemaining: expiration === null ? null : Math.max(0, expiration - nowSeconds),
          standingSince: condition?.since ?? null,
          reminders: condition?.alerts ?? null,
        }
      }),
    )
    muted.push(...batch)
  }

  // Order for the reader (L609): a mute with no expiry never lifts on its own
  // and is the one the issue warns stays silent for ever, so it leads; then by
  // soonest return, so what is about to start paging again comes next. Ties
  // break on the job name, for a stable order.
  return muted.sort((a, b) => {
    if (a.secondsRemaining === null && b.secondsRemaining === null) return a.jobName.localeCompare(b.jobName)
    if (a.secondsRemaining === null) return -1
    if (b.secondsRemaining === null) return 1
    if (a.secondsRemaining !== b.secondsRemaining) return a.secondsRemaining - b.secondsRemaining
    return a.jobName.localeCompare(b.jobName)
  })
}
