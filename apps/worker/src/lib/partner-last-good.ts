/**
 * The durable copy of a partner's config that the Partner Bid node bids from
 * when the partner_configs read fails (#1296), and the one way to retire it
 * (#1846). The node and every route that changes or removes a partner share
 * this module, so the key the routes delete is the key the node reads.
 *
 * Why the copy exists: the config is read from the database on every attempt so
 * an edit (a cap, a formula, disabling a partner) applies to the very next
 * lead. That read had no fallback, so on 2026-09-10, with Supabase unresponsive
 * for ten minutes, every attempt threw "Partner config not found" and no lead
 * could bid. A copy of the last row read is kept in KV with no TTL and served
 * only when the read FAILS, never when the row is genuinely missing.
 *
 * Why it is retired: nothing touched the copy when a partner was switched off,
 * edited or deleted, so in an outage a partner turned off minutes earlier still
 * bid from it. Every route writing partner_configs now calls
 * retirePartnerLastGood after its write lands (a guard in
 * apps/web/src/lib/__guards__/worker/last-good-copies-retired.test.ts enumerates
 * those routes from source), and the next successful read writes a fresh copy.
 *
 * KV allows one write a second per key, so the copy is rewritten only when the
 * row's updated_at moves, tracked per isolate. Two things keep that record from
 * blocking a fresh copy after a retire: retiring forgets this isolate's record,
 * and in every other isolate the partner_configs_updated_at trigger moves
 * updated_at on every UPDATE, so their record no longer matches the row. A
 * deleted partner has no row to read, and the first read that finds it gone
 * removes any copy a racing lead wrote after the retire.
 *
 * The copy is served for at most STORED_COPY_MAX_AGE_MS after it was last
 * confirmed (#1847), and carries that time in its KV metadata, so the value is
 * still the row exactly as the release before wrote it. A read confirms it when
 * the row changed or when this isolate last wrote it STORED_COPY_RECONFIRM_AFTER_MS
 * ago, so a partner that keeps bidding keeps a fresh copy at one write per
 * isolate per five minutes; the per minute stored copy sweep confirms the copy
 * of a partner no lead has reached, against the row's updated_at.
 */
import { formatErr } from './format-error'
import { STORED_COPY_RECONFIRM_AFTER_MS, confirmedAt, judgeCopyAge, readConfirmedCopy, refuseStoredCopy, serveStoredCopy } from './stored-copy-age'

/** The KV key holding a partner's last-good config. */
export const partnerLastGoodKey = (partnerId: string): string => `partner-lastgood:${partnerId}`

// The updated_at this isolate last wrote, per partner, and when. Module state on
// purpose: it lives as long as the isolate, which is what keeps the write rate down.
const lastGoodWritten = new Map<string, { stamp: string; atMs: number }>()

interface PartnerRow {
  id: string
  updated_at?: string | null
}

/**
 * Forget which stamps this isolate wrote. Only the outage drill calls it (#1305,
 * money-gate/harness/isolate-memory.ts): it resets storage between runs, and this
 * record would otherwise stop a warm run writing the copy reset() removed.
 */
export function forgetPartnerLastGoodMemory(): void {
  lastGoodWritten.clear()
}

/**
 * Write the copy, stamped as confirmed at `nowMs`, when the row has changed
 * since this isolate last wrote it or that write is due to be confirmed again.
 * Never throws.
 */
export async function rememberPartnerLastGood(kv: KVNamespace | undefined, partner: PartnerRow, nowMs: number): Promise<void> {
  if (!kv) return
  const stamp = partner.updated_at ?? ''
  const written = lastGoodWritten.get(partner.id)
  if (written && written.stamp === stamp && nowMs - written.atMs < STORED_COPY_RECONFIRM_AFTER_MS) return
  try {
    await kv.put(partnerLastGoodKey(partner.id), JSON.stringify(partner), confirmedAt(nowMs))
    lastGoodWritten.set(partner.id, { stamp, atMs: nowMs })
  } catch (e) {
    // The bid must not fail because the safety copy could not be written.
    console.error(`[partner-bid] last-good write failed for ${partner.id}: ${formatErr(e)}`)
  }
}

/**
 * The copy, read only after a failed database read: null when there is none or
 * it does not parse. Throws StoredCopyRefusedError, with the refusal logged,
 * when it is past the maximum age or carries no readable confirmation (#1847).
 */
export async function readPartnerLastGood<T>(kv: KVNamespace | undefined, partnerId: string, dbError: string, nowMs: number): Promise<T | null> {
  if (!kv) return null
  let held: Awaited<ReturnType<typeof readConfirmedCopy>>
  try {
    held = await readConfirmedCopy(kv, partnerLastGoodKey(partnerId))
  } catch (err) {
    // Counted as unusable, and answered as a null like any other refusal.
    console.error(`[partner-last-good] the last-good copy of partner ${partnerId} could not be read: ${formatErr(err)}`)
    refuseStoredCopy({ copy: 'partner_config', subject: partnerId, reason: 'copy_unusable', ageMs: null, dbError })
    return null
  }
  let copy: T | null = null
  if (held) {
    try {
      copy = JSON.parse(held.value) as T
    } catch {
      copy = null
    }
  }
  if (!held || copy === null) {
    // Logged and counted as a refusal (#1848); the caller still answers a null.
    refuseStoredCopy({ copy: 'partner_config', subject: partnerId, reason: held ? 'copy_unusable' : 'no_copy', ageMs: null, dbError })
    return null
  }
  const age = judgeCopyAge(held.confirmedAt, nowMs)
  if (!age.usable) throw refuseStoredCopy({ copy: 'partner_config', subject: partnerId, reason: age.reason, ageMs: age.ageMs, dbError })
  serveStoredCopy({ copy: 'partner_config', subject: partnerId, ageMs: age.ageMs, dbError })
  return copy
}

/**
 * Delete the copy and forget that this isolate wrote it. Called by every route
 * that changes or removes a partner, after the write lands. Throws when KV
 * refuses: a copy that could not be retired is exactly the stale record this
 * exists to remove, so the route must not report a clean success over it.
 * With no KV binding there is no copy to retire.
 */
export async function retirePartnerLastGood(kv: KVNamespace | undefined, partnerId: string): Promise<void> {
  lastGoodWritten.delete(partnerId)
  if (!kv) return
  await kv.delete(partnerLastGoodKey(partnerId))
}

/**
 * Remove a copy left behind for a partner the database says no longer exists.
 * Reads first, so a node that keeps naming a deleted partner spends no KV write
 * once the copy is gone. Never throws: the caller is already refusing the bid.
 */
export async function dropPartnerLastGoodIfPresent(kv: KVNamespace | undefined, partnerId: string): Promise<void> {
  lastGoodWritten.delete(partnerId)
  if (!kv) return
  try {
    if ((await kv.get(partnerLastGoodKey(partnerId))) !== null) await kv.delete(partnerLastGoodKey(partnerId))
  } catch (e) {
    console.error(`[partner-bid] could not remove the last-good copy of missing partner ${partnerId}: ${formatErr(e)}`)
  }
}
