/**
 * Refuses personal data in anything the money gate commits or generates (#1704).
 *
 * The fixtures are meant to carry no real person (L2, L482). This is the check that
 * they do not, run over the shapes, the config snapshot, the arm variants and every
 * payload the generator builds. It errs towards accusing: a synthetic value has to
 * come from a range no real value can (an SSN area the SSA never issues, a date of
 * birth pinned to the first of January, an account number of zeros), so the
 * generator, not the scanner, carries the burden of being obviously fake.
 */

export type FindingKind = 'ssn' | 'dob' | 'card' | 'account'

export interface Finding {
  kind: FindingKind
  path: string
}

const ACCOUNT_PATH = /(account|routing|iban|aba)/i
const DOB_PATH = /(dob|birth)/i

/** SSN areas the SSA never issues: 000, 666 and 900 to 999. */
function isNeverIssuedArea(area: string): boolean {
  return area === '000' || area === '666' || area[0] === '9'
}

function ssnDigits(s: string): string | null {
  const m = /^(\d{3})-?(\d{2})-?(\d{4})$/.exec(s.trim())
  if (m) return m[1] + m[2] + m[3]
  const spaced = /^(\d{3}) (\d{2}) (\d{4})$/.exec(s.trim())
  return spaced ? spaced[1] + spaced[2] + spaced[3] : null
}

function luhnValid(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) { d *= 2; if (d > 9) d -= 9 }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

function dateParts(s: string): { month: string; day: string } | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (iso) return { month: iso[2], day: iso[3] }
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)
  if (us) return { month: us[1].padStart(2, '0'), day: us[2].padStart(2, '0') }
  return null
}

function scanLeaf(path: string, value: string, out: Finding[]): void {
  const lastSegment = path.split(/[.[\]]+/).filter(Boolean).pop() ?? ''
  if (ACCOUNT_PATH.test(lastSegment)) {
    // An identifier (subAccountUuid) is a UUID, not a bank account number.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return
    const digits = value.replace(/\D/g, '')
    if (digits.length >= 6 && /[1-9]/.test(digits)) out.push({ kind: 'account', path })
    return
  }
  if (DOB_PATH.test(lastSegment)) {
    const parts = dateParts(value)
    if (parts && !(parts.month === '01' && parts.day === '01')) out.push({ kind: 'dob', path })
    return
  }
  const ssn = ssnDigits(value)
  if (ssn && !isNeverIssuedArea(ssn.slice(0, 3))) {
    out.push({ kind: 'ssn', path })
    return
  }
  const compact = value.replace(/[ -]/g, '')
  if (/^\d{13,19}$/.test(compact) && /[1-9]/.test(compact) && luhnValid(compact)) out.push({ kind: 'card', path })
}

export function scanForPersonalData(value: unknown, path = ''): Finding[] {
  const out: Finding[] = []
  const visit = (v: unknown, p: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => visit(x, `${p}[${i}]`))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, p ? `${p}.${k}` : k)
    else if (typeof v === 'string') scanLeaf(p, v, out)
    else if (typeof v === 'number' && Number.isInteger(v)) scanLeaf(p, String(v), out)
  }
  visit(value, path)
  return out
}
