/**
 * Usable-contact detection (#723, point 4)
 *
 * A lead is sellable because we can reach the person. When Salesforce rejects an
 * unrepairable email and we blank it (see email-repair.ts), a surviving phone
 * number still makes the lead worth creating. If NOTHING reachable survives,
 * the run should fail saying exactly that, rather than surfacing an opaque
 * Salesforce 400 that reads like an outage.
 *
 * This is lead-domain knowledge sitting in a generic node, which is a real
 * tradeoff, accepted deliberately: the alternative is reading the synced
 * Salesforce schema on every write to learn which field is a phone. The
 * detection is therefore name-based and conservative, and it is only ever
 * consulted on the error path, so a wrong guess cannot affect a healthy run.
 */

/** Enough digits to dial a North American number. */
export const PHONE_MIN_DIGITS = 10

/** Any field whose name mentions a phone: Phone__c, MobilePhone, primaryPhone. */
const PHONE_KEY = /phone/i

const DIGITS = /[0-9]/g

function countDigits(value: string): number {
  return (value.match(DIGITS) ?? []).length
}

/**
 * Does this request body carry at least one phone number we could actually
 * dial? Walks nested objects and arrays, since bodies are not always flat.
 */
export function hasUsablePhone(body: unknown): boolean {
  if (Array.isArray(body)) return body.some((entry) => hasUsablePhone(entry))
  if (body === null || typeof body !== 'object') return false

  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (PHONE_KEY.test(key)) {
      if (typeof value === 'string' && countDigits(value) >= PHONE_MIN_DIGITS) return true
      if (typeof value === 'number' && countDigits(String(value)) >= PHONE_MIN_DIGITS) return true
    }
    if (value !== null && typeof value === 'object' && hasUsablePhone(value)) return true
  }
  return false
}
