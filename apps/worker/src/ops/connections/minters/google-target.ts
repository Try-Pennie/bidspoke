/**
 * The one reading of a Google connection's target (#2819, lesson L263): the
 * mailbox it acts as, trimmed and lower cased, and the shared drive ids it
 * names, exactly as stored. The target is `{ subject: "<mailbox>", drives?:
 * ["<shared drive id>", ...] }`; anything else is unreadable, drives given as
 * text rather than a list among it.
 *
 * The Google minter reads every mint through it (googleSubjectsOf in
 * google.ts, which refuses an unreadable target as target_invalid), and the
 * bidding Worker's save and the list's removal check read through it too
 * (lib/connection-create.ts), so a target is never read one way at save and
 * another at mint. It imports nothing, so the bidding Worker takes none of the
 * minter's signing in with it.
 */

/** google_delegation_check takes at most this many drives. */
export const MAX_DECLARED_DRIVES = 100

const MAILBOX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type GoogleTargetReading = { ok: true; mailbox: string; drives: string[] } | { ok: false }

export function readGoogleTarget(target: unknown): GoogleTargetReading {
  if (target === null || typeof target !== 'object' || Array.isArray(target)) return { ok: false }
  const fields = target as Readonly<Record<string, unknown>>
  const subject = Object.hasOwn(fields, 'subject') ? fields.subject : undefined
  if (typeof subject !== 'string') return { ok: false }
  const mailbox = subject.trim().toLowerCase()
  if (!MAILBOX.test(mailbox)) return { ok: false }
  const raw = Object.hasOwn(fields, 'drives') ? fields.drives : undefined
  if (raw === undefined) return { ok: true, mailbox, drives: [] }
  if (!Array.isArray(raw) || raw.length > MAX_DECLARED_DRIVES || !raw.every((d): d is string => typeof d === 'string' && d !== '')) return { ok: false }
  return { ok: true, mailbox, drives: [...raw] }
}
