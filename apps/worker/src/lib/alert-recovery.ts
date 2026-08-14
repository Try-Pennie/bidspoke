/**
 * All-clear notifications for the rate-aggregated alerts (#253).
 *
 * volume-cliff, failure-rate and slow-execution-rate all page when a rate STARTS
 * spiking and say nothing when it recovers. That makes silence ambiguous in the
 * worst possible way: it means both "still broken, suppressed by the cooldown"
 * and "fine again", which are the two states a reader most needs to tell apart
 * during an incident.
 *
 * THE RECOVERY MARKER IS NOT THE COOLDOWN KEY. They answer different questions:
 * the cooldown says "do not page again yet", the marker says "we owe an
 * all-clear". Reading the second off the first (LESSONS L53, two independent
 * facts sharing one field) would break on precisely the outages that matter,
 * because the cooldown is 30 minutes: anything longer expires it, and the
 * recovery would then arrive with nothing to say it had ever been broken. So the
 * marker gets its own key and a TTL long enough to outlive a real outage.
 */

/** KV surface these checks share. Canonical here so the three copies converge. */
export interface RecoveryKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * How long we remember that we owe an all-clear. Deliberately far longer than
 * the 30 minute cooldown, so a multi-hour outage still gets announced when it
 * ends. It is a backstop, not a schedule: the marker is normally cleared by the
 * recovery itself.
 */
export const RECOVERY_TTL_SECONDS = 24 * 60 * 60

/** Key holding the time we first paged for `id`. */
export function recoveryKey(prefix: string, id: string): string {
  return `${prefix}-recovery:${id}`
}

/**
 * Record that an alert delivered, so a later healthy check knows to announce the
 * recovery.
 *
 * Does NOT overwrite an existing marker. A long outage re-alerts each time the
 * cooldown lapses, and overwriting would reset the clock, so the all-clear would
 * report a minutes-long blip after hours of downtime.
 */
export async function markAlerted(
  kv: RecoveryKv,
  prefix: string,
  id: string,
  now: number = Date.now(),
): Promise<void> {
  const key = recoveryKey(prefix, id)
  if (await kv.get(key)) return
  await kv.put(key, new Date(now).toISOString(), { expirationTtl: RECOVERY_TTL_SECONDS })
}

/**
 * Call on a HEALTHY check. If we previously paged for `id`, send the all-clear
 * and clear both keys. Returns whether an all-clear was delivered.
 *
 * `send` receives the ISO time of the first page so the message can say how long
 * it lasted, and returns whether it actually reached Slack.
 *
 * On a failed or throwing send BOTH keys are left alone, so the next tick tries
 * again. This is the mirror of "only start the cooldown once the alert
 * delivered": a kicked bot during recovery must not swallow the all-clear and
 * leave the page as the last word.
 */
export async function announceRecovery(
  kv: RecoveryKv,
  prefix: string,
  id: string,
  cooldownKey: string,
  send: (alertedAt: string) => Promise<boolean>,
): Promise<boolean> {
  const key = recoveryKey(prefix, id)
  const alertedAt = await kv.get(key)
  if (!alertedAt) return false

  let delivered = false
  try {
    delivered = await send(alertedAt)
  } catch (err) {
    console.error(`[alert-recovery] ${prefix} all-clear failed for ${id}:`, err)
    return false
  }
  if (!delivered) return false

  await kv.delete(key)
  await kv.delete(cooldownKey)
  return true
}
