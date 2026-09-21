import { US_STATES, type UsState } from './vocab'

/**
 * A positive finite amount from a payload value, or null.
 *
 * Null is the only failure value, and callers map it to `missing_lead_field`
 * BEFORE any comparison, so NaN can never pass a minimum and a zero or negative
 * debt can never produce a negative payout (L50, L706, #1328, #1359).
 */
export function parsePositiveAmount(input: unknown): number | null {
  let n: number
  if (typeof input === 'number') {
    n = input
  } else if (typeof input === 'string') {
    const cleaned = input.trim().replace(/^\$/, '').replace(/,/g, '')
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
    n = Number(cleaned)
  } else {
    return null
  }
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

const STATE_NAMES: Record<string, UsState> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
  COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', 'DISTRICT OF COLUMBIA': 'DC',
  FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL',
  INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA',
  MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN',
  MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR',
  PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD',
  TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA',
  WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY',
}

const STATE_SET: ReadonlySet<string> = new Set(US_STATES)

/**
 * A US_STATES member from a raw payload value, or null (L147).
 *
 * Accepts a two letter code in any case with stray spaces or periods, or a full
 * name in any case. Anything else, a territory included, is null, which callers
 * map to `missing_lead_field`.
 */
export function parseUsState(input: unknown): UsState | null {
  if (typeof input !== 'string') return null
  const normalised = input.trim().toUpperCase().replace(/\./g, '').replace(/\s+/g, ' ')
  if (normalised === '') return null
  if (STATE_SET.has(normalised)) return normalised as UsState
  return STATE_NAMES[normalised] ?? null
}
