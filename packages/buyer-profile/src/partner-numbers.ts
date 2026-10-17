/**
 * The partner record's numbers (#2328): the daily attempt cap, the circuit
 * breaker's error count, the confirmation window, the routing code, and the
 * HTTP status a rule names. The partners page used to leave these to the
 * browser's own limits, whose popup blocked a save silently and whose absence
 * let the page round 2.5 down to 2. Now the page judges them with this rule
 * before any write and the Worker judges them again, so a refusal is said
 * beside its field in the page's own words. It lives in this package because
 * the web app cannot import the Worker.
 *
 * Every value stored on 2026-10-17 passes: no daily cap, confirmation window or
 * status rule set, every error count 5, and both routing codes 2.
 */

export interface PartnerNumberError {
  code: 'partner_number_invalid'
  /** The partner column the error is about, which is also its partners page registry field. */
  path: string
  field: string
  message: string
}

/** The largest value an integer column holds. */
const INT_MAX = 2147483647

/** Each column, the range it accepts (whole numbers only), and the sentence that refuses it. */
const RULES: readonly { field: string; min: number; max: number; message: string }[] = [
  { field: 'daily_cap', min: 1, max: INT_MAX, message: 'Daily attempt cap is a whole number, 1 or more.' },
  { field: 'circuit_error_threshold', min: 1, max: INT_MAX, message: 'Errors is a whole number, 1 or more.' },
  { field: 'confirmation_window_ms', min: 1, max: INT_MAX, message: 'Confirmation window is a whole number of milliseconds, 1 or more.' },
  // external_routing_code is a smallint column.
  { field: 'external_routing_code', min: 0, max: 32767, message: 'The routing code is a whole number from 0 to 32,767.' },
]

const STATUS_MESSAGE = 'An HTTP status in a rule is a whole number from 100 to 599.'
const SIGNAL_GROUPS = ['rejection_signals', 'transient_signals', 'permanent_signals'] as const

function wholeIn(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

/** The refusals for a partner save body; empty when every number it names is acceptable. A field it leaves out or sets to null is not judged. */
export function partnerNumberErrors(body: Readonly<Record<string, unknown>>): PartnerNumberError[] {
  const out: PartnerNumberError[] = []
  const refuse = (field: string, message: string) => out.push({ code: 'partner_number_invalid', path: field, field, message })
  for (const rule of RULES) {
    const value = body[rule.field]
    if (value === undefined || value === null) continue
    if (!wholeIn(value, rule.min, rule.max)) refuse(rule.field, rule.message)
  }
  const rc = body.response_classification
  if (rc !== null && typeof rc === 'object' && !Array.isArray(rc)) {
    const groups = rc as Record<string, unknown>
    const statuses = SIGNAL_GROUPS.flatMap((g) => (Array.isArray(groups[g]) ? (groups[g] as unknown[]) : []))
      .filter((s): s is Record<string, unknown> => s !== null && typeof s === 'object' && 'status_code' in s)
      .map((s) => s.status_code)
    if (statuses.some((code) => !wholeIn(code, 100, 599))) refuse('response_classification', STATUS_MESSAGE)
  }
  return out
}
