/**
 * Acknowledged differences (#1704): how a pull request that MEANS to change what
 * the bidding engine sends or decides gets through the money gate.
 *
 * apps/worker/money-gate/expected-changes.json lists each expected difference by
 * workflow, check, node and field pattern, with a written reason. An entry excuses
 * a difference only when it is NEW in this change: present at the head and absent,
 * in exactly that form, at the merge base. So an excuse counts in the change that
 * adds it (on the pull request, and again on the push to main, whose base is the
 * commit before), and from then on it is carried over and excuses nothing, which
 * means it can never mask a later pull request.
 *
 * A new entry that matches no difference fails the gate by name: an excuse for a
 * change that did not happen is a defect (a typo in the pattern, or a change that
 * was reverted). A carried over entry is inert and is listed so it can be deleted.
 */
import { CHECKS, canonical, type Check, type Difference } from './compare'

export interface ExpectedChange {
  /** Workflow name, as the fixture ids carry it (`Main Flow`). */
  workflow: string
  check: Check
  /** Node pattern; absent matches any node. `*` matches any run of characters. */
  node?: string
  /**
   * Replay pattern, matched against the fixture id after `<workflow>/`, so an
   * entry can name only some replays, `* as shadow *` for every shadow run
   * (#1780). Absent matches every replay of the workflow.
   */
  fixture?: string
  /** Field pattern, `*` for any run of characters, matched against the whole field. */
  field: string
  /** Why this difference is intended, in words. */
  reason: string
}

const MIN_REASON = 10

function globToRegex(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
}

function describeEntry(e: ExpectedChange): string {
  return `${e.workflow} ${e.check}${e.node !== undefined ? ` node ${e.node}` : ''}${e.fixture !== undefined ? ` fixture ${JSON.stringify(e.fixture)}` : ''} field ${JSON.stringify(e.field)}`
}

/** Parses the file, refusing malformed entries by name rather than skipping them. A missing file is no entries. */
export function parseExpectedChanges(text: string | null): { entries: ExpectedChange[]; failures: string[] } {
  if (text === null) return { entries: [], failures: [] }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return { entries: [], failures: ['expected-changes.json does not parse as JSON'] }
  }
  const raw = (doc as { entries?: unknown })?.entries
  if (!Array.isArray(raw)) return { entries: [], failures: ['expected-changes.json has no entries array'] }
  const entries: ExpectedChange[] = []
  const failures: string[] = []
  raw.forEach((e: Partial<ExpectedChange>, i) => {
    const problems: string[] = []
    if (typeof e?.workflow !== 'string' || !e.workflow) problems.push('no workflow')
    if (!(CHECKS as readonly string[]).includes(String(e?.check))) problems.push(`unknown check ${JSON.stringify(e?.check)}`)
    if (typeof e?.field !== 'string' || !e.field) problems.push('no field pattern')
    if (e?.node !== undefined && typeof e.node !== 'string') problems.push('a node that is not a string')
    if (e?.fixture !== undefined && typeof e.fixture !== 'string') problems.push('a fixture that is not a string')
    // A reason must start with a word and say something (L675).
    if (typeof e?.reason !== 'string' || !/^[A-Za-z]/.test(e.reason) || e.reason.trim().length < MIN_REASON) problems.push('no written reason')
    if (problems.length) failures.push(`expected-changes.json entry ${i}: ${problems.join(', ')}`)
    else entries.push(e as ExpectedChange)
  })
  return { entries, failures }
}

function matches(e: ExpectedChange, d: Difference): boolean {
  const prefix = `${e.workflow}/`
  return d.fixture.startsWith(prefix) &&
    (e.fixture === undefined || globToRegex(e.fixture).test(d.fixture.slice(prefix.length))) &&
    d.check === e.check &&
    (e.node === undefined || (d.node !== undefined && globToRegex(e.node).test(d.node))) &&
    globToRegex(e.field).test(d.field)
}

export function applyExpectedChanges(
  diffs: Difference[],
  headEntries: ExpectedChange[],
  baseEntries: ExpectedChange[],
): {
  excused: Array<{ diff: Difference; entry: ExpectedChange }>
  unexcused: Difference[]
  carriedOver: ExpectedChange[]
  failures: string[]
} {
  const atBase = new Set(baseEntries.map(canonical))
  const fresh = headEntries.filter((e) => !atBase.has(canonical(e)))
  const carriedOver = headEntries.filter((e) => atBase.has(canonical(e)))
  const used = new Set<ExpectedChange>()
  const excused: Array<{ diff: Difference; entry: ExpectedChange }> = []
  const unexcused: Difference[] = []
  for (const d of diffs) {
    // Every matching entry is credited, so two overlapping entries both count as used.
    const matching = fresh.filter((x) => matches(x, d))
    for (const e of matching) used.add(e)
    if (matching.length) excused.push({ diff: d, entry: matching[0] })
    else unexcused.push(d)
  }
  const failures = fresh.filter((e) => !used.has(e)).map((e) => `expected change for ${describeEntry(e)} matched no difference; remove it or fix its pattern`)
  return { excused, unexcused, carriedOver, failures }
}

export { describeEntry }

/**
 * What money-gate.sh hands the verdict for the merge base's copy: the path of the
 * file, or this marker when git confirmed the file does not exist at the base
 * commit (the change that first adds it). Anything else fails by name, never as
 * "the base had no entries", which would let every head entry excuse again (L42).
 */
export const ABSENT_AT_BASE = 'absent-at-base'

export function resolveExpectedBase(
  handedOver: string | undefined,
  fs: { exists: (p: string) => boolean; read: (p: string) => string },
): { text: string | null; failure: string | null } {
  if (!handedOver) return { text: null, failure: "the merge base's expected-changes.json was not handed over (MONEY_GATE_EXPECTED_BASE), so which entries are new cannot be told" }
  if (handedOver === ABSENT_AT_BASE) return { text: null, failure: null }
  if (!fs.exists(handedOver)) return { text: null, failure: `the merge base's expected-changes.json at ${handedOver} cannot be read, so which entries are new cannot be told` }
  return { text: fs.read(handedOver), failure: null }
}
