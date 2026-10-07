/**
 * The one age rule for every stored outage copy (#1847, plan A4 on #1675).
 *
 * A stored copy is a last-good copy kept in KV with no expiry and served ONLY
 * when the database read fails: a workflow definition, a custom endpoint, a
 * partner config, an organization's environment variables, its partner
 * constants and its buyer profiles. Before this, a copy was served at any age,
 * so a long outage, or a copy nothing had refreshed for days, ran leads on rules
 * nobody could confirm. Dan decided on 2026-10-07 that a copy older than thirty
 * minutes is refused, by name, separately from a failed read and from no copy.
 *
 * "Age" is the time since the copy was last CONFIRMED against the database, not
 * since its content last changed: a copy whose rows have not changed for a week
 * is still good if a healthy read looked at them a minute ago. So every copy
 * records when it was last confirmed, and healthy reads (and the per minute
 * prewarm and stored copy sweep, for a copy no lead happens to read) confirm it
 * again at most once every STORED_COPY_RECONFIRM_AFTER_MS, which keeps KV writes
 * far inside its one write a second per key.
 *
 * Where the confirmation time lives:
 * - workflow definition copies: `written_at` in the value (#1845 wrote it);
 * - buyer profile copies: `loaded_at` in the value (#1557 wrote it);
 * - every other copy: KV metadata (`confirmedAt` on the put, readConfirmedCopy
 *   on the read), so the value keeps the exact shape the release before reads
 *   and writes, and an encrypted copy needs no second encryption.
 *
 * Every loader judges its copy with judgeCopyAge, serves it with
 * serveStoredCopy and refuses with refuseStoredCopy, so the rule and the words
 * for it exist once, and every serve and refusal is counted in the stored copy
 * ledger the per minute check alerts from (#1848).
 */
import { stripUrlQueriesInText } from './url-redact'
import { noteStoredCopy } from './stored-copy-ledger'

/** The oldest a stored copy may be, since it was last confirmed, and still be served (Dan, 2026-10-07). */
export const STORED_COPY_MAX_AGE_MS = 30 * 60 * 1000

/**
 * A copy is confirmed again once it is this old, by whichever healthy read or
 * cron reaches it first. Five of these fit inside the maximum age, so a healthy
 * copy survives several missed confirmations before it ages out. Also the bound
 * on extra KV writes: at most one per copy per five minutes from any one writer.
 */
export const STORED_COPY_RECONFIRM_AFTER_MS = 5 * 60 * 1000

/**
 * A confirmation time this far ahead of the reader's clock is damage, not a
 * difference between two isolates' clocks, and is trusted no more than none.
 */
export const STORED_COPY_FUTURE_TOLERANCE_MS = 60 * 1000

/** Which stored copy, as named in logs and errors. */
export type StoredCopyKind = 'workflow_definition' | 'custom_endpoint' | 'partner_config' | 'env_vars' | 'partner_constants' | 'buyer_profiles'

export const COPY_LABELS: Record<StoredCopyKind, string> = {
  workflow_definition: 'the workflow definition',
  custom_endpoint: 'the custom endpoint',
  partner_config: 'the partner config',
  env_vars: 'the environment variables',
  partner_constants: 'the partner constants',
  buyer_profiles: 'the buyer profiles',
}

/**
 * Why a copy is not served. Each is its own reason, so a log or an alert can
 * tell an outage with no copy from one whose copy had gone stale, or one whose
 * copy was there but could not be read, parsed or decrypted (`copy_unusable`).
 */
export type StoredCopyRefusal = 'no_copy' | 'copy_too_old' | 'copy_age_unknown' | 'copy_unusable'

export type CopyAgeVerdict =
  | { usable: true; ageMs: number }
  | { usable: false; reason: 'copy_too_old' | 'copy_age_unknown'; ageMs: number | null }

/**
 * Whether a copy last confirmed at `confirmed` may be served at `nowMs`. A
 * confirmation time that is missing, not a time, or far in the future refuses
 * (fail closed: a copy nobody can date is a copy nobody can trust). A node may
 * pass a STRICTER bound; a looser one throws, so no caller can serve longer
 * than the shared maximum.
 */
export function judgeCopyAge(confirmed: unknown, nowMs: number, maxAgeMs: number = STORED_COPY_MAX_AGE_MS): CopyAgeVerdict {
  if (!(maxAgeMs > 0 && maxAgeMs <= STORED_COPY_MAX_AGE_MS)) {
    throw new Error(`a stored copy bound of ${maxAgeMs} ms is looser than the shared maximum of ${STORED_COPY_MAX_AGE_MS} ms`)
  }
  const at = typeof confirmed === 'string' && confirmed !== '' ? Date.parse(confirmed) : Number.NaN
  if (!Number.isFinite(at)) return { usable: false, reason: 'copy_age_unknown', ageMs: null }
  const ageMs = nowMs - at
  if (ageMs < -STORED_COPY_FUTURE_TOLERANCE_MS) return { usable: false, reason: 'copy_age_unknown', ageMs }
  if (ageMs > maxAgeMs) return { usable: false, reason: 'copy_too_old', ageMs }
  return { usable: true, ageMs }
}

/**
 * Whether a healthy read should confirm this copy again: its confirmation is at
 * least STORED_COPY_RECONFIRM_AFTER_MS old, or cannot be trusted at all.
 */
export function isDueForReconfirm(confirmed: unknown, nowMs: number): boolean {
  const verdict = judgeCopyAge(confirmed, nowMs)
  if (!verdict.usable && verdict.reason === 'copy_age_unknown') return true
  return verdict.ageMs === null || verdict.ageMs >= STORED_COPY_RECONFIRM_AFTER_MS
}

/** What a copy carries in its KV metadata. */
export interface CopyConfirmation {
  confirmed_at: string
}

/** The put options that stamp a copy as confirmed at `nowMs`. */
export function confirmedAt(nowMs: number): { metadata: CopyConfirmation } {
  return { metadata: { confirmed_at: new Date(nowMs).toISOString() } }
}

/**
 * A copy stamped through its metadata, with its confirmation time as stored
 * (unknown: judgeCopyAge decides what it is worth). Null when there is no copy.
 * Throws when KV does.
 */
export async function readConfirmedCopy(kv: KVNamespace, key: string): Promise<{ value: string; confirmedAt: unknown } | null> {
  const { value, metadata } = await kv.getWithMetadata<Partial<CopyConfirmation>>(key)
  if (value === null) return null
  return { value, confirmedAt: metadata && typeof metadata === 'object' ? metadata.confirmed_at : undefined }
}

/** A stored copy refused in a database outage. `reason` says which refusal. */
export class StoredCopyRefusedError extends Error {
  readonly reason: StoredCopyRefusal
  readonly copy: StoredCopyKind
  readonly ageMs: number | null

  constructor(copy: StoredCopyKind, subject: string, reason: StoredCopyRefusal, ageMs: number | null, dbError: string) {
    super(`The database read of ${COPY_LABELS[copy]} for ${subject} failed (${dbError}), and ${refusalWords(reason, ageMs)}, so it is refused.`)
    this.name = 'StoredCopyRefusedError'
    this.reason = reason
    this.copy = copy
    this.ageMs = ageMs
  }
}

function refusalWords(reason: StoredCopyRefusal, ageMs: number | null): string {
  const limit = `${STORED_COPY_MAX_AGE_MS / 60_000} minute limit`
  if (reason === 'no_copy') return 'there is no stored copy to serve'
  if (reason === 'copy_unusable') return 'its stored copy could not be read or was not fit to serve'
  if (reason === 'copy_too_old') return `its stored copy was last confirmed ${ageMs === null ? 'at an unknown time' : `${Math.floor(ageMs / 60_000)} minutes ago`}, past the ${limit}`
  return 'its stored copy carries no readable confirmation time'
}

/**
 * Says, in one structured line, that a stored copy was refused and why, and
 * returns the named error for the caller to throw (or to answer with, where the
 * caller answers rather than throws).
 */
export function refuseStoredCopy(args: { copy: StoredCopyKind; subject: string; reason: StoredCopyRefusal; ageMs: number | null; dbError: string }): StoredCopyRefusedError {
  noteStoredCopy({ copy: args.copy, outcome: args.reason, ageMs: args.ageMs })
  console.error(stripUrlQueriesInText(JSON.stringify({
    event: 'stored_copy_refused',
    copy: args.copy,
    subject: args.subject,
    reason: args.reason,
    copy_age_ms: args.ageMs,
    max_age_ms: STORED_COPY_MAX_AGE_MS,
    db_error: args.dbError,
  })))
  return new StoredCopyRefusedError(args.copy, args.subject, args.reason, args.ageMs, args.dbError)
}

/**
 * Says, in one structured line, that a stored copy was served in place of the
 * database, and counts it (#1848). Every loader calls it at the moment it hands
 * its copy back, so an outage being absorbed is never silent. `detail` adds the
 * fields one copy has and the others do not (a workflow's version, say).
 */
export function serveStoredCopy(args: { copy: StoredCopyKind; subject: string; ageMs: number; dbError: string; detail?: Record<string, unknown> }): void {
  noteStoredCopy({ copy: args.copy, outcome: 'served', ageMs: args.ageMs })
  console.warn(stripUrlQueriesInText(JSON.stringify({
    event: 'stored_copy_served',
    copy: args.copy,
    subject: args.subject,
    copy_age_ms: args.ageMs,
    max_age_ms: STORED_COPY_MAX_AGE_MS,
    db_error: args.dbError,
    ...args.detail,
  })))
}
