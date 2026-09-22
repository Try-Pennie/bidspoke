/**
 * The one mapping between a stored signal (`@bidspoke/buyer-profile` Signal)
 * and the three things a rule row shows: a field, an operator and a value
 * typed as text (#1463, L370). Both rule editors read it, the accept rules
 * editor and the response classification builder, so a rule written by one is
 * read by the other as itself. The operator is found by iterating the shared
 * vocabulary, so an operator added there is read and written here without a
 * second list to forget (L41).
 */
import { SIGNAL_OPERATORS, type Signal, type SignalOperator } from '@bidspoke/buyer-profile'

/** The operators whose value is a list, typed as comma separated text. */
export const LIST_OPERATORS: ReadonlySet<SignalOperator> = new Set(['in', 'not_in'])

/** A comma separated list, numeric tokens kept numeric, everything else text (the legacy rule builder's reading). */
export function parseList(text: string): unknown[] {
  return text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => (/^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t))
}

export function listToString(arr: unknown[]): string {
  return arr.map((v) => (v == null ? '' : String(v))).join(',')
}

/** The operator a signal carries, or equals when it carries none yet. */
export function operatorOf(sig: Signal): SignalOperator {
  for (const op of SIGNAL_OPERATORS) if (sig[op] !== undefined) return op
  return 'equals'
}

/** The value a signal carries, as the text the box shows. */
export function valueTextOf(sig: Signal): string {
  const op = operatorOf(sig)
  const v = sig[op]
  if (op === 'present') return ''
  if (Array.isArray(v)) return listToString(v)
  return v === undefined || v === null ? '' : String(v)
}

/** A typed scalar: numbers and booleans come back as themselves, everything else stays text. */
function scalar(text: string): unknown {
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  if (text === 'true') return true
  if (text === 'false') return false
  return text
}

/** Rebuild a signal from its field, operator and text. */
export function signalFrom(field: string, op: SignalOperator, text: string): Signal {
  if (op === 'present') return { field, present: true }
  if (LIST_OPERATORS.has(op)) return { field, [op]: parseList(text) } as Signal
  if (op === 'equals') return { field, equals: scalar(text) }
  return { field, [op]: text } as Signal
}
