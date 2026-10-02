/**
 * Reading the Salesforce revenue formulas into one rule per partner, and saying
 * where the formulas disagree (#1419).
 *
 * Three formulas book partner revenue, and each carries its own copy of every
 * partner's rates: Lead.ExternalRevenue__c, Submission__c.ExternalRevenue__c and
 * Prospect__c.ExternalExchangeRevenue__c. They are edited by hand, one at a
 * time, and on 2026-09-30 the Lead copy priced Tripoint at 0.0012 from $12,500
 * while the other two used 0.0013. A person found it by reading the three side
 * by side. This is the pure half of the check that now does that daily; the
 * scheduled half is `tripoint-pricing-check.ts`. It is also the one parser of
 * these formulas: `parseTripointRevenueFormula` reads its Tripoint rule from
 * here rather than matching the text a second way.
 *
 * WHAT IT READS. Each formula is a chain of partner branches,
 *   IF(<partner field> = "Name", <price>, IF(<partner field> = "Other", ..., 0))
 * optionally wrapped in IF(ISPICKVAL(<status>, "Completed"), <chain>, 0). A
 * price is one of: a ladder of debt bands (IF(<debt range>, <debt> * RATE,
 * <next band>) ending in 0, or a bare <debt> * RATE), a field whose value is
 * booked as it is (TotalPayout__c), or 0. The debt may be spelled any of the
 * three ways the org has used (#1640), but one ladder must use one spelling.
 *
 * A LADDER IS COMPARED AS THE FUNCTION IT COMPUTES, never as text. `< 12500`
 * and `<= 12499` are the same band on whole dollar debts, so they agree; a
 * non whole dollar edge has no such reading and is refused.
 *
 * WHAT IT REFUSES. A formula that is not a chain of partner branches is
 * unrecognised as a whole, and one branch of an unfamiliar shape is
 * unrecognised on its own while the other branches are still read. Both are
 * findings, never "no partners" or "no rate" (L98, L11).
 *
 * ONLY RATES ARE COMPARED. A partner booked as a rate on debt in any formula is
 * compared strictly across all of them. A partner booked only as a field or as
 * nothing (Engine, AmOne) differs between the formulas by design today, since
 * the Prospect formula books neither, so that is a note, not a daily page (L36).
 */

import type { PricingDifference } from './tripoint-pricing-drift'

/** One paid band, inclusive on whole dollars of debt. Null is unbounded on that side. */
export interface Band {
  from: number | null
  to: number | null
  rate: number
}

export type PartnerPricing =
  | { kind: 'bands'; bands: Band[] }
  | { kind: 'field'; field: string }
  | { kind: 'nothing' }
  | { kind: 'unrecognised'; text: string }

/** A band rule as written, in the order the formula tests it. */
export interface BandRule {
  from: number | null
  to: number | null
  rate: number
}

export interface RevenueFormulaReading {
  /** Partner name to its price, in the order the branches appear. */
  partners: Map<string, PartnerPricing>
  /** Each rate-priced partner's band rules as written, before they are flattened into bands. */
  rules: Map<string, BandRule[]>
}

/** A finding about the formulas, the same shape the Tripoint comparison reports. */
export type FormulaFinding = PricingDifference

// ---------------------------------------------------------------------------
// A small parser for the formula language, enough for these formulas and no
// more. Anything it does not know is a parse failure, never a guess.
// ---------------------------------------------------------------------------

type Node =
  | { t: 'num'; v: number; raw: string }
  | { t: 'str'; v: string }
  | { t: 'ref'; name: string }
  | { t: 'call'; fn: string; args: Node[] }
  | { t: 'bin'; op: string; l: Node; r: Node }

type Token = { k: 'num' | 'str' | 'id' | 'op' | 'punct'; v: string }

function tokenize(src: string): Token[] | null {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    const num = /^\d+(?:\.\d+)?/.exec(src.slice(i))
    if (num) {
      tokens.push({ k: 'num', v: num[0] })
      i += num[0].length
      continue
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))
    if (id) {
      tokens.push({ k: 'id', v: id[0] })
      i += id[0].length
      continue
    }
    if (c === '"') {
      const end = src.indexOf('"', i + 1)
      if (end < 0) return null
      tokens.push({ k: 'str', v: src.slice(i + 1, end) })
      i = end + 1
      continue
    }
    const op = /^(<=|>=|<>|!=|==|=|<|>|\*|\/|\+|-)/.exec(src.slice(i))
    if (op) {
      tokens.push({ k: 'op', v: op[0] === '==' ? '=' : op[0] === '!=' ? '<>' : op[0] })
      i += op[0].length
      continue
    }
    if (c === '(' || c === ')' || c === ',') {
      tokens.push({ k: 'punct', v: c })
      i++
      continue
    }
    return null
  }
  return tokens
}

const COMPARISON = new Set(['=', '<>', '<', '<=', '>', '>='])

function parse(src: string): Node | null {
  const tokens = tokenize(src)
  if (!tokens) return null
  let pos = 0
  const peek = () => tokens[pos]
  const fail = (): never => {
    throw new SyntaxError('unparseable')
  }
  const expect = (v: string) => {
    if (peek()?.v !== v) fail()
    pos++
  }

  function primary(): Node {
    const tok = peek()
    if (!tok) return fail()
    pos++
    if (tok.k === 'num') return { t: 'num', v: Number(tok.v), raw: tok.v }
    if (tok.k === 'str') return { t: 'str', v: tok.v }
    if (tok.k === 'id') {
      if (peek()?.v !== '(') return { t: 'ref', name: tok.v }
      pos++
      const args: Node[] = []
      if (peek()?.v !== ')') {
        args.push(comparison())
        while (peek()?.v === ',') {
          pos++
          args.push(comparison())
        }
      }
      expect(')')
      return { t: 'call', fn: tok.v.toUpperCase(), args }
    }
    if (tok.v === '(') {
      const inner = comparison()
      expect(')')
      return inner
    }
    return fail()
  }
  function binaryLevel(next: () => Node, ops: Set<string>): () => Node {
    return () => {
      let l = next()
      while (peek()?.k === 'op' && ops.has(peek().v)) {
        const op = peek().v
        pos++
        l = { t: 'bin', op, l, r: next() }
      }
      return l
    }
  }
  const multiplicative = binaryLevel(primary, new Set(['*', '/']))
  const additive = binaryLevel(multiplicative, new Set(['+', '-']))
  const comparison = binaryLevel(additive, COMPARISON)

  try {
    const root = comparison()
    return pos === tokens.length ? root : null
  } catch {
    return null
  }
}

/** The node written back compactly, for messages and for recognising the debt. */
function print(n: Node): string {
  switch (n.t) {
    case 'num':
      return n.raw
    case 'str':
      return `"${n.v}"`
    case 'ref':
      return n.name
    case 'call':
      return `${n.fn}(${n.args.map(print).join(', ')})`
    case 'bin':
      return `${print(n.l)} ${n.op} ${print(n.r)}`
  }
}

// ---------------------------------------------------------------------------
// Reading the parsed formula as partner branches.
// ---------------------------------------------------------------------------

/** The partner field is spelled two ways across objects (Lead against Submission). */
const PARTNER_FIELDS = new Set(['ExternalPartnerName__c', 'External_Partner_Name__c'])

/**
 * The debt a band is priced on, in each spelling the org has used: the old
 * ExternalDebtAmount__c alone, EngineDebt__c alone (Prospect, 2026-09-29), and
 * EngineDebt__c when present else ExternalDebtAmount__c (Lead and Submission,
 * 2026-09-29, #1640).
 */
const DEBT_SPELLINGS = new Set([
  'ExternalDebtAmount__c',
  'EngineDebt__c',
  'IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c)',
])

const isZero = (n: Node) => n.t === 'num' && n.v === 0

function call(n: Node, fn: string, arity: number): Node[] | null {
  return n.t === 'call' && n.fn === fn && n.args.length === arity ? n.args : null
}

/**
 * The chain of partner branches, or null when the formula is not one. Strips
 * the Completed wrapper first, whose else must be 0 (the Prospect formula once
 * had none at all).
 */
export function readRevenueFormula(formula: string): RevenueFormulaReading | null {
  const root = parse(formula)
  if (!root) return null
  let chain = root
  const wrapper = call(root, 'IF', 3)
  if (wrapper) {
    const pick = call(wrapper[0], 'ISPICKVAL', 2)
    if (pick && pick[0].t === 'ref' && pick[1].t === 'str' && pick[1].v === 'Completed') {
      if (!isZero(wrapper[2])) return null
      chain = wrapper[1]
    }
  }

  const partners = new Map<string, PartnerPricing>()
  const rules = new Map<string, BandRule[]>()
  let partnerField: string | null = null
  let node = chain
  for (;;) {
    if (isZero(node)) break
    const branch = call(node, 'IF', 3)
    if (!branch) return null
    const test = branch[0]
    if (test.t !== 'bin' || test.op !== '=' || test.l.t !== 'ref' || test.r.t !== 'str') return null
    if (!PARTNER_FIELDS.has(test.l.name)) return null
    if (partnerField !== null && partnerField !== test.l.name) return null
    partnerField = test.l.name
    const name = test.r.v
    // A second branch for the same partner is never reached: Salesforce takes the first.
    if (!partners.has(name)) {
      const read = readPrice(branch[1])
      partners.set(name, read.pricing)
      if (read.rules) rules.set(name, read.rules)
    }
    node = branch[2]
  }
  return { partners, rules }
}

function readPrice(n: Node): { pricing: PartnerPricing; rules?: BandRule[] } {
  if (isZero(n)) return { pricing: { kind: 'nothing' } }
  if (n.t === 'ref') return { pricing: { kind: 'field', field: n.name } }
  const state: { debt: string | null } = { debt: null }
  const rules = readLadder(n, state)
  if (!rules) return { pricing: { kind: 'unrecognised', text: print(n) } }
  const bands = flatten(rules)
  return { pricing: bands.length === 0 ? { kind: 'nothing' } : { kind: 'bands', bands }, rules }
}

/** Is this node the debt, in the one spelling this ladder has used so far? */
function isDebt(n: Node, state: { debt: string | null }): boolean {
  const text = print(n)
  if (!DEBT_SPELLINGS.has(text)) return false
  if (state.debt === null) state.debt = text
  return state.debt === text
}

/** `<debt> * RATE` or `RATE * <debt>`, as the rate; 0 as 0; null for anything else. */
function readRate(n: Node, state: { debt: string | null }): number | null {
  if (isZero(n)) return 0
  if (n.t !== 'bin' || n.op !== '*') return null
  if (n.r.t === 'num' && isDebt(n.l, state)) return n.r.v
  if (n.l.t === 'num' && isDebt(n.r, state)) return n.l.v
  return null
}

function readLadder(n: Node, state: { debt: string | null }): BandRule[] | null {
  const flat = readRate(n, state)
  if (flat !== null) return flat === 0 ? [] : [{ from: null, to: null, rate: flat }]
  const step = call(n, 'IF', 3)
  if (!step) return null
  const range = readRange(step[0], state)
  const rate = readRate(step[1], state)
  if (!range || rate === null) return null
  const rest = readLadder(step[2], state)
  if (!rest) return null
  return [{ ...range, rate }, ...rest]
}

/** A comparison of the debt with a whole dollar figure, or an AND of them, as an inclusive range. */
function readRange(n: Node, state: { debt: string | null }): { from: number | null; to: number | null } | null {
  const and = n.t === 'call' && n.fn === 'AND' ? n.args : [n]
  if (and.length === 0) return null
  let from: number | null = null
  let to: number | null = null
  for (const c of and) {
    if (c.t !== 'bin' || !COMPARISON.has(c.op) || c.r.t !== 'num' || !isDebt(c.l, state)) return null
    const v = c.r.v
    // Debts are whole dollars, so `< 12500` is `<= 12499`. An edge with cents has
    // no such reading, so it is an unfamiliar shape rather than a guess.
    if (!Number.isInteger(v)) return null
    let lo: number | null = null
    let hi: number | null = null
    if (c.op === '>=') lo = v
    else if (c.op === '>') lo = v + 1
    else if (c.op === '<=') hi = v
    else if (c.op === '<') hi = v - 1
    else return null
    if (lo !== null) from = from === null ? lo : Math.max(from, lo)
    if (hi !== null) to = to === null ? hi : Math.min(to, hi)
  }
  return { from, to }
}

/**
 * The bands a ladder actually pays, as the function it computes: each stretch
 * of debt takes the first rule that covers it, stretches paying nothing are
 * dropped, and neighbours at one rate are joined. So two ladders written
 * differently but paying the same compare equal.
 */
function flatten(rules: BandRule[]): Band[] {
  const points = new Set<number>()
  for (const r of rules) {
    if (r.from !== null) points.add(r.from)
    if (r.to !== null) points.add(r.to + 1)
  }
  const sorted = [...points].sort((a, b) => a - b)
  const segments: Array<{ from: number | null; to: number | null }> = []
  let start: number | null = null
  for (const p of sorted) {
    segments.push({ from: start, to: p - 1 })
    start = p
  }
  segments.push({ from: start, to: null })

  const covers = (r: BandRule, s: { from: number | null; to: number | null }) =>
    (r.from === null || (s.from !== null && r.from <= s.from)) && (r.to === null || (s.to !== null && s.to <= r.to))

  const bands: Band[] = []
  for (const s of segments) {
    const rate = rules.find((r) => covers(r, s))?.rate ?? 0
    if (rate === 0) continue
    const last = bands[bands.length - 1]
    if (last && last.rate === rate && last.to !== null && s.from === last.to + 1) last.to = s.to
    else bands.push({ from: s.from, to: s.to, rate })
  }
  return bands
}

// ---------------------------------------------------------------------------
// Comparing the formulas.
// ---------------------------------------------------------------------------

export type FormulaRead = { object: string; formula: string } | { object: string; error: string }

/** People read these, so thousands separators on debts and every digit of a rate. */
const dollars = (n: number): string => n.toLocaleString('en-US')
const pct = (n: number): string => `${Number((n * 100).toPrecision(12))}%`

function bandText(b: Band, first: boolean): string {
  const rate = first ? `${pct(b.rate)} of debt` : pct(b.rate)
  if (b.from !== null && b.to !== null) return `${rate} from $${dollars(b.from)} to $${dollars(b.to)}`
  if (b.from !== null) return `${rate} from $${dollars(b.from)} up`
  if (b.to !== null) return `${rate} up to $${dollars(b.to)}`
  return rate
}

function list(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** One sentence saying what a group of formulas pays a partner. */
function paysSentence(objects: string[], partner: string, pricing: PartnerPricing): string {
  const subject = `The ${list(objects)} ${objects.length === 1 ? 'formula pays' : 'formulas pay'}`
  switch (pricing.kind) {
    case 'bands':
      return `${subject} ${partner} ${list(pricing.bands.map((b, i) => bandText(b, i === 0)))}.`
    case 'field':
      return `${subject} ${partner} the value of ${pricing.field}.`
    default:
      return `${subject} nothing for ${partner}.`
  }
}

const sameBands = (a: Band[], b: Band[]) =>
  a.length === b.length && a.every((x, i) => x.from === b[i].from && x.to === b[i].to && x.rate === b[i].rate)

function samePricing(a: PartnerPricing, b: PartnerPricing): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'bands' && b.kind === 'bands') return sameBands(a.bands, b.bands)
  if (a.kind === 'field' && b.kind === 'field') return a.field === b.field
  return true
}

/**
 * Every partner whose rates differ between the formulas that were read, each as
 * one finding, plus a finding for each formula or branch that could not be
 * read. Fewer than two readable formulas compare nothing, and the findings say
 * why, so that case is never silent agreement.
 */
export function compareRevenueFormulas(reads: FormulaRead[]): { differences: FormulaFinding[]; notes: FormulaFinding[] } {
  const differences: FormulaFinding[] = []
  const notes: FormulaFinding[] = []
  const readable: Array<{ object: string; reading: RevenueFormulaReading }> = []

  for (const r of reads) {
    if ('error' in r) {
      differences.push({
        code: 'formula-unreadable',
        object: r.object,
        message: `The check couldn't read the Salesforce ${r.object} formula: ${r.error}`,
      })
      continue
    }
    const reading = readRevenueFormula(r.formula)
    if (!reading) {
      differences.push({
        code: 'formula-unrecognised',
        object: r.object,
        message: `The Salesforce ${r.object} formula has been rewritten in a form the check can't read. It now says: ${r.formula.replace(/\s+/g, ' ').slice(0, 300)}`,
      })
      continue
    }
    for (const [partner, pricing] of reading.partners) {
      if (pricing.kind === 'unrecognised') {
        differences.push({
          code: 'branch-unrecognised',
          object: r.object,
          partner,
          message: `The Salesforce ${r.object} formula prices ${partner} in a form the check can't read: ${pricing.text.slice(0, 300)}`,
        })
      }
    }
    readable.push({ object: r.object, reading })
  }
  if (readable.length < 2) return { differences, notes }

  const partnerNames: string[] = []
  for (const { reading } of readable) for (const name of reading.partners.keys()) if (!partnerNames.includes(name)) partnerNames.push(name)

  for (const partner of partnerNames) {
    // A partner a formula has no branch for falls through to 0 there.
    const priced = readable
      .map(({ object, reading }) => ({ object, pricing: reading.partners.get(partner) ?? { kind: 'nothing' as const } }))
      .filter((p) => p.pricing.kind !== 'unrecognised')
    if (priced.length < 2) continue

    const groups: Array<{ objects: string[]; pricing: PartnerPricing }> = []
    for (const p of priced) {
      const g = groups.find((x) => samePricing(x.pricing, p.pricing))
      if (g) g.objects.push(p.object)
      else groups.push({ objects: [p.object], pricing: p.pricing })
    }
    if (groups.length < 2) continue

    const sentences = groups.map((g) => paysSentence(g.objects, partner, g.pricing)).join(' ')
    if (groups.some((g) => g.pricing.kind === 'bands')) {
      differences.push({ code: 'formulas-disagree', partner, message: sentences })
    } else {
      notes.push({
        code: 'formulas-differ-not-rate',
        partner,
        message: `The formulas book ${partner} differently, but not as a rate on debt, so the check does not compare it. ${sentences}`,
      })
    }
  }
  return { differences, notes }
}
