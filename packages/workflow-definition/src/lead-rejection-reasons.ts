/**
 * The reasons a lead validation step sends a partner when it rejects a lead
 * (#2588, part of #935).
 *
 * Each is the exact `reason` text a live `validate_bidding_and_state` script
 * returns today, read on 2026-10-21 from RML GigFi, RML LendSwift and Lead
 * Economy. Partners and our own reporting match on that text, so spelling is
 * kept exactly, including both `unqualified` (GigFi) and `unqualified_lead`
 * (Lead Economy). Unifying spellings is #935's decision, not this list's.
 *
 * APPEND ONLY. A reason is never removed, respelled or reordered: a saved
 * definition that names it would otherwise send a reason no list vouches for.
 * The package test pins the declared prefix, and the web guard
 * `lead-rejection-reasons-cover-definitions` fails when a committed definition
 * sends a reason missing from here.
 */
export const LEAD_REJECTION_REASONS = [
  'bidding not active',
  'ineligible state',
  'invalid name',
  'loan amount exceeds maximum',
  'military status ineligible',
  'unqualified',
  'employment status missing',
  'missing phone',
  'unqualified_lead',
] as const

export type LeadRejectionReason = (typeof LEAD_REJECTION_REASONS)[number]

const REASON_SET: ReadonlySet<string> = new Set(LEAD_REJECTION_REASONS)

export function isLeadRejectionReason(value: unknown): value is LeadRejectionReason {
  return typeof value === 'string' && REASON_SET.has(value)
}

/**
 * The used reasons absent from `listed`, each once, in the order first used.
 * `listed` defaults to the real list; a test passes a shortened one to see the
 * check fail on a removed reason.
 */
export function missingRejectionReasons(
  used: Iterable<string>,
  listed: readonly string[] = LEAD_REJECTION_REASONS,
): string[] {
  const known = new Set(listed)
  const missing: string[] = []
  for (const reason of used) {
    if (!known.has(reason) && !missing.includes(reason)) missing.push(reason)
  }
  return missing
}
