/**
 * Code node print sites that existed when the scan shipped (#1230, #1214).
 *
 * These are ACCEPTED, not approved. Every one of them prints consumer data into
 * a stream the platform captures before any redaction of ours can run. They are
 * listed so the daily check alerts only on something NEW, because a standing
 * finding nobody can action today, delivered on a schedule, is what teaches
 * people to skip the whole alert (L36, L269).
 *
 * The list is therefore a statement of what is owed, not a way of forgetting it.
 * The work is #1214, and every line removed from here is a line fixed on the
 * canvas. When this array is empty the entry should go with it.
 *
 * Measured 2026-09-09 by running the scan over all eleven live definitions.
 * `sanitizedBody` is named for forwarding, not redaction: its allowlist includes
 * `personalInformation`, so those sites print name, address and date of birth.
 */
export interface AcceptedPrintSite {
  readonly workflow: string
  readonly namespace: string
  readonly identifier: string
}

export const ACCEPTED_PRINT_SITES: readonly AcceptedPrintSite[] = [
  { workflow: 'Main Flow', namespace: 'fallback_engine_debt_missing', identifier: 'sanitizedBody' },
  { workflow: 'Main Flow', namespace: 'fallback_engine_under_10000', identifier: 'sanitizedBody' },
  { workflow: 'Main Flow', namespace: 'fallback_invalid_state', identifier: 'sanitizedBody' },
  { workflow: 'Main Flow', namespace: 'pennie_or_eligibility', identifier: 'result' },
  { workflow: 'Main Flow (v2)', namespace: 'fallback_engine_debt_missing', identifier: 'sanitizedBody' },
  { workflow: 'Main Flow (v2)', namespace: 'fallback_engine_under_10000', identifier: 'sanitizedBody' },
  { workflow: 'Main Flow (v2)', namespace: 'fallback_invalid_state', identifier: 'sanitizedBody' },
  { workflow: 'Main Flow (v2)', namespace: 'pennie_or_eligibility', identifier: 'parsedBody' },
  { workflow: 'Main Flow (v2)', namespace: 'pennie_or_eligibility', identifier: 'result' },
]

/** Keyed on all three, so the same node printing a DIFFERENT value is new. */
export function isAccepted(site: AcceptedPrintSite): boolean {
  return ACCEPTED_PRINT_SITES.some(
    (a) =>
      a.workflow === site.workflow &&
      a.namespace === site.namespace &&
      a.identifier === site.identifier,
  )
}
