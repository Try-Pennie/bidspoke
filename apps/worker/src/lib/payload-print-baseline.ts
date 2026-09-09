/**
 * Code node print sites that existed when the scan shipped (#1230, #1214).
 *
 * These are ACCEPTED BY DECISION, and the decision is not to fix them (Dan,
 * 2026-09-09, on #1214). Read that before treating this list as a to-do.
 *
 * The reasoning: what made these urgent was the applicant's SSN reaching an
 * EXTERNAL vendor through the Logpush `Logs` field, and that stopped when the
 * field list was narrowed to metadata (#1007), with the daily check in #1010
 * alerting if a PII bearing field is ever added back. What remains is consumer
 * data inside our own systems, which ADR 0006 deliberately allows and which was
 * reaffirmed the same day with the archive's 13 month retention in view (#1221).
 *
 * So the list exists so the daily check alerts only on something NEW. A standing
 * finding nobody intends to action, delivered on a schedule, is what teaches
 * people to skip the whole alert (L36, L269).
 *
 * What would make this list wrong again: a NEW Logpush destination carrying
 * `Logs`, which #1010 watches for, or ADR 0006 being reversed. Either should
 * bring the canvas work back, and #1214 holds the reasoning to reopen from.
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
