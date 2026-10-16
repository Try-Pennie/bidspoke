/**
 * Each History entry in plain words (#2141, PR10 of #2114): a line per change,
 * the old value struck through and the new in bold, as the settled design
 * (docs/design/partners-page.html, rounds 29 and 30) draws them.
 *
 * Labels come from the partners page registry (partner-draft.ts) and the buyer
 * profile's own label list (labels.ts), so History names a field as its form
 * does (L118). A buyer profile path is written by buyer_profile_flatten in the
 * database's spelling, so it passes through normaliseSqlPath before the
 * registry is asked about it. A path nothing names is shown under its raw name
 * and returned in `unregistered`, which the panel logs with its count: never
 * dropped and never an error (L96).
 *
 * What is not a line: the bookkeeping a writer adds beside the changes (keys
 * starting with an underscore, the partner id a row is tied by), and a created
 * row's own id, organization and timestamps. Everything else in `changes` is a
 * line, so a shape this file has not met still reads as its raw key and value.
 */
import { DAYS_OF_WEEK, normaliseSqlPath } from '@bidspoke/buyer-profile'
import type { HistoryEntry } from '@bidspoke/partner-history'
import { PROFILE_PREFIX, registryEntriesFor } from '@/app/(app)/partners/partner-draft'
import { formatDollars, formatProfileValue, profileFieldLabel, SECTION_LABELS } from '@/components/partners/buyer-profile/labels'
import { formatTime } from '@/components/ui/date-time'
import { directChangeMinutes, pickupSentenceFrom } from '@/lib/bidding-pickup'
import { etDayHeading, etDayKey } from '@/lib/dates'

export type HistoryLine =
  /** A value that changed: struck through old, bold new. */
  | { kind: 'change'; label: string; from: string; to: string }
  /** A value something was set up with, where there was nothing before. */
  | { kind: 'set'; label: string; value: string }
  | { kind: 'text'; text: string }

export interface DescribedEntry {
  lines: HistoryLine[]
  /** Raw keys no registry entry names, shown under that name and logged by the panel. */
  unregistered: string[]
}

type Pair = { old: unknown; new: unknown }
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isPair = (v: unknown): v is Pair => isRecord(v) && Object.keys(v).length === 2 && 'old' in v && 'new' in v
const absent = (v: unknown) => v === null || v === undefined

/** A created row's own columns, which describe the row rather than a setting anyone chose. */
const ROW_BOOKKEEPING = new Set(['id', 'organization_id', 'created_at', 'updated_at', 'updated_by', 'updated_by_email', 'updated_by_name', 'version', 'partner_id', 'old_partner_id'])

/**
 * Fields older rows name that the page no longer edits. bid_mode was dropped
 * (#2182); rows written before then still carry it, so it is labelled as gone
 * rather than counted as a registry gap on every read.
 */
const RETIRED_LABELS: Record<string, string> = { bid_mode: 'Bid mode (since removed)' }

/** A matrix config's own columns (partner-bid-configs.ts BidConfigBody), as the matrix editor names them. */
const MATRIX_CONFIG_LABELS: Record<string, string> = {
  name: 'Name', slug: 'Slug', is_default: 'Default matrix', is_active: 'Active', sync_source: 'Synced from',
  sf_object: 'Salesforce object', sf_filters: 'Salesforce filters', dimensions: 'Dimensions',
}

/** A matrix row's tracked fields (bid-matrix-sync.ts TRACKED_FIELDS). */
const MATRIX_ROW_FIELD_LABELS: Record<string, string> = {
  bid_amount: 'bid', is_sell_off: 'sell-off', row_low: 'row from', row_high: 'row to', range_low: 'range from', range_high: 'range to',
}

/** The buyer profile tables the direct edit trigger watches, by the part of the profile each holds. */
const PROFILE_TABLE_LABELS: Record<string, string> = {
  buyer_profiles: 'Buyer profile',
  buyer_pricing_tiers: SECTION_LABELS.tiers,
  buyer_operating_windows: SECTION_LABELS.windows,
  buyer_blackout_dates: SECTION_LABELS.blackout_dates,
}
const OP_PAST: Record<string, string> = { INSERT: 'added', UPDATE: 'updated', DELETE: 'deleted' }

const HELD_STATE: Record<string, string> = { in_flight: 'held', sold: 'marked sent', free: 'freed' }

/** A partner setting's value: none for nothing, yes or no, else the value as stored. */
function formatSetting(v: unknown): string {
  if (absent(v)) return 'none'
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (Array.isArray(v) && v.length === 0) return 'none'
  if (isRecord(v) && Object.keys(v).length === 0) return 'none'
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return JSON.stringify(v)
}

class Lines {
  readonly lines: HistoryLine[] = []
  readonly unregistered: string[] = []
  text(text: string) { this.lines.push({ kind: 'text', text }) }
  /** A change, or for a value that did not exist before on a created row, what it was set up with. */
  value(label: string, from: string, to: string, created: boolean, wasAbsent: boolean) {
    if (created && wasAbsent) this.lines.push({ kind: 'set', label, value: to })
    else this.lines.push({ kind: 'change', label, from, to })
  }
}

function partnerLabel(key: string, out: Lines): string {
  const entry = registryEntriesFor(key)[0]
  if (entry) return entry.label
  if (RETIRED_LABELS[key]) return RETIRED_LABELS[key]
  out.unregistered.push(key)
  return key
}

function joinLabels(keys: readonly string[], label: (k: string) => string): string {
  return keys.map(label).join(', ')
}

/** An older full form save recorded the settings it sent, not what changed or to what. */
function savedFields(fields: string[], out: Lines) {
  out.text(fields.length > 3
    ? `Saved ${fields.length} settings at once; the values were not recorded.`
    : `Saved ${joinLabels(fields, (k) => partnerLabel(k, out))}; the values were not recorded.`)
}

function describePartner(e: HistoryEntry, c: Record<string, unknown>, out: Lines) {
  const created = e.action === 'created'
  if (created) out.text('Created the partner.')
  const fields = Array.isArray(c.changed_fields) ? c.changed_fields.map(String) : null
  const hasBeforeAfter = 'before' in c && 'after' in c
  if (hasBeforeAfter) {
    // A hand written row: the field it names, its value before and after, and why.
    out.value(fields && fields.length > 0 ? joinLabels(fields, (k) => partnerLabel(k, out)) : 'Value', formatSetting(c.before), formatSetting(c.after), false, false)
  } else if (fields) {
    savedFields(fields, out)
  }
  for (const [key, v] of Object.entries(c)) {
    if (key.startsWith('_') || key === 'changed_fields' || ROW_BOOKKEEPING.has(key)) continue
    if (hasBeforeAfter && (key === 'before' || key === 'after')) continue
    if (key === 'note' || key === 'reason') {
      out.text(`${key === 'note' ? 'Note' : 'Reason'}: ${formatSetting(v)}`)
      continue
    }
    const label = partnerLabel(key, out)
    if (isPair(v)) out.value(label, formatSetting(v.old), formatSetting(v.new), created, absent(v.old))
    else out.value(label, 'none', formatSetting(v), created, true)
  }
}

// ── The buyer profile ───────────────────────────────────────────────────────

const DOTTED_WINDOW = /^windows\.(\d)\.(\d+)$/
const DOTTED_TIER = /^tiers\.([^.]+)\.(\d+(?:\.\d+)?)\.(multiplier|debt_to)$/

function isRegisteredProfilePath(path: string): boolean {
  try {
    return registryEntriesFor(`${PROFILE_PREFIX}${normaliseSqlPath(path)}`).length > 0
  } catch {
    return false
  }
}

function windowText(opens: number, closes: number): string {
  return opens === 0 && closes >= 1440 ? 'all day' : `${formatTime(opens)} to ${formatTime(closes)}`
}

/**
 * One day's changed windows on one side. A dotted window path holds the
 * closing minute, so a window exists on a side when its value is there. Only
 * the windows this save touched are listed, as everywhere in History.
 */
function windowsSide(wins: Array<{ opens: number; closes: unknown }>): string {
  const present = wins.filter((w) => typeof w.closes === 'number').sort((a, b) => a.opens - b.opens)
  return present.length === 0 ? 'none' : present.map((w) => windowText(w.opens, w.closes as number)).join(', ')
}

function dayRange(days: number[]): string {
  const name = (d: number) => DAYS_OF_WEEK.find((x) => x.index === d)?.label ?? `Day ${d}`
  return days.length === 1 ? name(days[0]) : `${name(days[0])} to ${name(days[days.length - 1])}`
}

function describeWindows(paths: Array<[string, Pair]>, created: boolean, out: Lines) {
  const byDay = new Map<number, Array<{ opens: number; old: unknown; new: unknown }>>()
  for (const [path, v] of paths) {
    const m = DOTTED_WINDOW.exec(path)!
    const day = Number(m[1])
    byDay.set(day, [...(byDay.get(day) ?? []), { opens: Number(m[2]), old: v.old, new: v.new }])
  }
  const perDay = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([day, wins]) => ({
    day,
    from: windowsSide(wins.map((w) => ({ opens: w.opens, closes: w.old }))),
    to: windowsSide(wins.map((w) => ({ opens: w.opens, closes: w.new }))),
  }))
  // A run of consecutive days with the same change is one line (the settled design's "Monday to Friday").
  const runs: Array<{ days: number[]; from: string; to: string }> = []
  for (const d of perDay) {
    const last = runs[runs.length - 1]
    if (last && last.from === d.from && last.to === d.to && last.days[last.days.length - 1] === d.day - 1) last.days.push(d.day)
    else runs.push({ days: [d.day], from: d.from, to: d.to })
  }
  for (const r of runs) out.value(`${SECTION_LABELS.windows}, ${dayRange(r.days)}`, r.from, r.to, created, r.from === 'none')
}

/**
 * Pricing tiers. A tier always has a multiplier, so one whose multiplier is
 * there on only one side was added or removed, and is one line; its upper bound
 * is absent when it has none, because the flatten leaves a null out. A tier on
 * both sides changed a field, and each field is its own line, because the
 * fields it kept are not in the row and cannot be shown.
 */
function describeTiers(paths: Array<[string, Pair]>, created: boolean, out: Lines) {
  const rows = new Map<string, { population: string; from: string; fields: Record<string, Pair> }>()
  for (const [path, v] of paths) {
    const m = DOTTED_TIER.exec(path)!
    const key = `${m[1]}:${m[2]}`
    const row = rows.get(key) ?? { population: m[1], from: m[2], fields: {} }
    row.fields[m[3]] = v
    rows.set(key, row)
  }
  for (const [key, row] of rows) {
    const mult = row.fields.multiplier
    const wholeRow = mult && absent(mult.old) !== absent(mult.new)
    if (wholeRow) {
      const side = (s: 'old' | 'new') => absent(mult[s]) ? 'none' : formatProfileValue(`tiers[${key}]`, { multiplier: mult[s], debt_to: row.fields.debt_to?.[s] ?? null })
      out.value(profileFieldLabel(`tiers[${key}]`), side('old'), side('new'), created, absent(mult.old))
    } else {
      for (const field of ['multiplier', 'debt_to'] as const) {
        const v = row.fields[field]
        if (!v) continue
        const path = `tiers.${row.population}.${row.from}.${field}`
        out.value(profileFieldLabel(path), formatProfileValue(path, v.old), formatProfileValue(path, v.new), created, absent(v.old))
      }
    }
  }
}

function routeStates(v: unknown): string {
  if (!isRecord(v)) return 'none'
  return Array.isArray(v.states) && v.states.length > 0 ? [...v.states].map(String).sort().join(', ') : 'every state no other route lists'
}

function statesChange(oldV: unknown[], newV: unknown[]): { from: string; to: string } {
  const before = new Set(oldV.map(String))
  const after = new Set(newV.map(String))
  const added = [...after].filter((s) => !before.has(s)).sort()
  const removed = [...before].filter((s) => !after.has(s)).sort()
  const parts = [String(after.size)]
  if (added.length) parts.push(`added ${added.join(', ')}`)
  if (removed.length) parts.push(`removed ${removed.join(', ')}`)
  return { from: String(before.size), to: parts.join(', ') }
}

function describeProfile(e: HistoryEntry, c: Record<string, unknown>, out: Lines) {
  const created = e.action === 'created'
  if (c._source === 'direct_sql' && typeof c.table === 'string') {
    // The trigger counts the rows a hand edit touched in one of the profile's tables.
    const part = PROFILE_TABLE_LABELS[c.table]
    if (!part) out.unregistered.push(c.table)
    const n = Number(c.rows)
    out.text(`${part ?? c.table}: ${n} ${n === 1 ? 'row' : 'rows'} ${OP_PAST[String(c.op)] ?? String(c.op).toLowerCase()}.`)
    return
  }
  if (created) out.text('Set up the buyer profile.')
  const windows: Array<[string, Pair]> = []
  const tiers: Array<[string, Pair]> = []
  for (const [path, v] of Object.entries(c)) {
    if (path.startsWith('_')) continue
    if (!isPair(v)) {
      out.unregistered.push(path)
      out.value(path, 'none', formatSetting(v), created, true)
      continue
    }
    if (!isRegisteredProfilePath(path)) {
      out.unregistered.push(path)
      out.value(path, formatSetting(v.old), formatSetting(v.new), created, absent(v.old))
      continue
    }
    if (DOTTED_WINDOW.test(path)) { windows.push([path, v]); continue }
    if (DOTTED_TIER.test(path)) { tiers.push([path, v]); continue }
    if (path === 'allowed_states' && Array.isArray(v.old) && Array.isArray(v.new)) {
      const s = statesChange(v.old, v.new)
      out.value(profileFieldLabel(path), s.from, s.to, false, false)
    } else if (path.startsWith('click_delivery.routes[')) {
      // A route's address is a live webhook, so History says where it sends, never the address.
      const moved = isRecord(v.old) && isRecord(v.new) && v.old.url !== v.new.url
      out.value(profileFieldLabel(path), absent(v.old) ? 'none' : routeStates(v.old), absent(v.new) ? 'none' : `${routeStates(v.new)}${moved ? ', new address' : ''}`, created, absent(v.old))
    } else if (path === 'click_delivery.success_pattern') {
      const both = !absent(v.old) && !absent(v.new)
      const side = (s: unknown) => absent(s) ? 'none' : both ? String(s) : 'set'
      out.value(profileFieldLabel(path), side(v.old), side(v.new), created, absent(v.old))
    } else {
      out.value(profileFieldLabel(path), formatProfileValue(path, v.old), formatProfileValue(path, v.new), created, absent(v.old))
    }
  }
  describeWindows(windows, created, out)
  describeTiers(tiers, created, out)
}

// ── Held clicks, sub-account IDs and matrices ───────────────────────────────

/** Whether a sale's Salesforce updates all landed, as held-clicks.ts records them. */
const writesSide = (v: unknown) => (isRecord(v) ? (v.complete === true ? 'all written' : 'not all written') : 'none')

function describeHeldClick(e: HistoryEntry, c: Record<string, unknown>, out: Lines) {
  // A cleared claim carries its subject under held_click.old (held-clicks.ts), every other row under subject.
  const cleared = isPair(c.held_click) && isRecord(c.held_click.old) ? c.held_click.old : null
  const subject = isRecord(c.subject) ? c.subject : cleared ?? {}
  const prospect = typeof subject.prospect_id === 'string' ? subject.prospect_id : 'unknown'
  if (e.action === 'deleted' && cleared) {
    const state = isPair(c.claim_state) ? HELD_STATE[String(c.claim_state.old)] : undefined
    return out.text(`Cleared the held click for prospect ${prospect} from the list${state ? `; it was ${state}` : ''}.`)
  }
  for (const [key, v] of Object.entries(c)) {
    // held_click is read above only as a clear's subject; on any other row it falls through and is shown.
    if (key.startsWith('_') || key === 'subject' || key === 'claim_generation') continue
    if (key === 'buyer_lead_id') {
      // With a claim state it is part of that line (marked sent, lead id ...);
      // alone it is a lead id added to a sold click (held-clicks.ts lead-id route).
      if (isPair(v) && !isPair(c.claim_state)) out.value(`Held click, prospect ${prospect}, lead id`, formatSetting(v.old), formatSetting(v.new), false, false)
      continue
    }
    if (key === 'salesforce_writes' && isPair(v)) {
      out.value(`Held click, prospect ${prospect}, Salesforce updates`, writesSide(v.old), writesSide(v.new), false, false)
      continue
    }
    if (key === 'claim_state' && isPair(v)) {
      const state = (s: unknown) => HELD_STATE[String(s)] ?? formatSetting(s)
      const lead = isPair(c.buyer_lead_id) && !absent(c.buyer_lead_id.new) ? `, lead id ${String(c.buyer_lead_id.new)}` : ''
      out.value(`Held click, prospect ${prospect}`, state(v.old), `${state(v.new)}${v.new === 'sold' ? lead : ''}`, false, false)
      continue
    }
    out.unregistered.push(key)
    if (isPair(v)) out.value(key, formatSetting(v.old), formatSetting(v.new), false, false)
    else out.text(`${key}: ${formatSetting(v)}`)
  }
}

function describeSubAccount(e: HistoryEntry, c: Record<string, unknown>, out: Lines) {
  const uuid = isPair(c.uuid) ? c.uuid : null
  if (e.action === 'created' && uuid) return out.text(`Added sub-account UUID ${formatSetting(uuid.new)}.`)
  if (e.action === 'deleted' && uuid) return out.text(`Removed sub-account UUID ${formatSetting(uuid.old)}.`)
  if (uuid) out.value('Sub-account UUID', formatSetting(uuid.old), formatSetting(uuid.new), false, false)
  if (isPair(c.partner_slug)) out.value('Sub-account UUID', `on ${formatSetting(c.partner_slug.old)}`, `on ${formatSetting(c.partner_slug.new)}`, false, false)
}

function matrixName(e: HistoryEntry, c: Record<string, unknown>): string {
  return e.matrix?.configName ?? (typeof c.name === 'string' ? c.name : null) ?? 'Bid matrix'
}

function matrixConfigLabel(key: string, out: Lines): string {
  if (MATRIX_CONFIG_LABELS[key]) return MATRIX_CONFIG_LABELS[key]
  out.unregistered.push(key)
  return key
}

function describeMatrixConfig(e: HistoryEntry, c: Record<string, unknown>, out: Lines) {
  const name = matrixName(e, c)
  if (e.action === 'created') return out.text(`Created the bid matrix ${name}.`)
  if (e.action === 'deleted') return out.text(`Deleted the bid matrix ${name}.`)
  const fields = Array.isArray(c.changed_fields) ? c.changed_fields.map(String) : []
  out.text(fields.length === 0
    ? `Saved the bid matrix ${name}; what changed was not recorded.`
    : `Saved the bid matrix ${name}: ${joinLabels(fields, (k) => matrixConfigLabel(k, out))}; the values were not recorded.`)
}

interface MatrixRow { range?: unknown; is_sell_off?: unknown; bid_amount?: unknown; changes?: unknown }
const rowsOf = (v: unknown): MatrixRow[] => (Array.isArray(v) ? v.filter(isRecord) as MatrixRow[] : [])
const money = (v: unknown) => (typeof v === 'number' ? formatDollars(v) : formatSetting(v))
const rowLabel = (r: MatrixRow) => `${r.is_sell_off === true ? 'Sell-off row' : 'Row'} ${formatSetting(r.range)}`

function describeMatrixSync(e: HistoryEntry, c: Record<string, unknown>, out: Lines) {
  const added = rowsOf(c.added)
  const edited = rowsOf(c.edited)
  const removed = rowsOf(c.removed)
  const n = (k: number, word: string, first: boolean) => `${k} ${first ? (k === 1 ? 'row ' : 'rows ') : ''}${word}`
  const counts = [[added.length, 'added'], [edited.length, 'edited'], [removed.length, 'removed']] as const
  const shown = counts.filter(([k]) => k > 0).map(([k, w], i) => n(k, w, i === 0))
  const read = typeof c.rows_fetched === 'number' ? ` (${c.rows_fetched} ${c.rows_fetched === 1 ? 'row' : 'rows'} read from Salesforce)` : ''
  out.text(`${matrixName(e, c)}: ${shown.length > 0 ? shown.join(', ') : 'no rows changed'}${read}.`)
  for (const r of added) out.value(rowLabel(r), 'none', money(r.bid_amount), false, false)
  for (const r of edited) {
    for (const ch of Array.isArray(r.changes) ? r.changes.filter(isRecord) : []) {
      const field = String(ch.field)
      const label = MATRIX_ROW_FIELD_LABELS[field]
      if (!label) out.unregistered.push(field)
      const fmt = field === 'bid_amount' ? money : formatSetting
      // Named as an added or removed row is: by what the row is now, sell-off or not.
      out.value(`${rowLabel(r)} ${label ?? field}`, fmt(ch.before), fmt(ch.after), false, false)
    }
  }
  for (const r of removed) out.value(rowLabel(r), money(r.bid_amount), 'removed', false, false)
}

/** An entry's lines, and the raw keys among them no registry names. */
export function describeEntry(e: HistoryEntry): DescribedEntry {
  const out = new Lines()
  const c = isRecord(e.changes) ? e.changes : {}
  switch (e.entityType) {
    case 'partner_config': describePartner(e, c, out); break
    case 'buyer_profile': describeProfile(e, c, out); break
    case 'held_click': describeHeldClick(e, c, out); break
    case 'partner_uuid': describeSubAccount(e, c, out); break
    case 'partner_bid_config': describeMatrixConfig(e, c, out); break
    case 'bid_matrix': describeMatrixSync(e, c, out); break
    default:
      // A kind the route started returning before this page learned it: shown
      // by its raw name with its values, and counted, never dropped (L96).
      out.unregistered.push(String(e.entityType))
      out.text(`${String(e.entityType)} ${e.action}.`)
      for (const [key, v] of Object.entries(c)) {
        if (key.startsWith('_')) continue
        if (isPair(v)) out.value(key, formatSetting(v.old), formatSetting(v.new), false, false)
        else out.text(`${key}: ${formatSetting(v)}`)
      }
  }
  if (out.lines.length === 0) out.text(`${e.action[0]?.toUpperCase() ?? ''}${e.action.slice(1)}; no values were recorded.`)
  return { lines: out.lines, unregistered: out.unregistered }
}

export interface HistoryDay { key: string; heading: string; entries: HistoryEntry[] }

/** Entries grouped by the Eastern day they fall on, in the order given (newest first from the route). */
export function groupByEtDay(entries: readonly HistoryEntry[], now: number): HistoryDay[] {
  const days: HistoryDay[] = []
  for (const e of entries) {
    const key = etDayKey(e.at)
    const last = days[days.length - 1]
    if (last && last.key === key) last.entries.push(e)
    else days.push({ key, heading: etDayHeading(e.at, now), entries: [e] })
  }
  return days
}

/**
 * Which half of the page a hand edit lands in, for directChangeMinutes in
 * bidding-pickup.ts (the rule #2135's live notice uses too): partner settings
 * and sub-account IDs are read through the partner constants copy, a profile
 * through the buyer profiles copy. Other kinds are read through neither copy,
 * so they carry no note.
 */
const PICKUP_HALF: Partial<Record<HistoryEntry['entityType'], 'partner' | 'profile'>> = {
  partner_config: 'partner',
  partner_uuid: 'partner',
  buyer_profile: 'profile',
}

/** When the note under a hand edit stops applying, or null when it carries none. */
function pickupEnds(e: HistoryEntry): number | null {
  if (e.editor.kind !== 'direct') return null
  const half = PICKUP_HALF[e.entityType]
  const at = Date.parse(e.at)
  if (!half || Number.isNaN(at)) return null
  return at + directChangeMinutes(half) * 60_000
}

/** For a change with no actor at all, while bidding may still be catching up to it, when it will. */
export function pickupNote(e: HistoryEntry, now: number): string | null {
  const ends = pickupEnds(e)
  const half = PICKUP_HALF[e.entityType]
  if (ends === null || !half || now > ends) return null
  return pickupSentenceFrom(half)
}

/** When the soonest pickup note on the list stops applying, so the panel can drop it then. */
export function nextPickupExpiry(entries: readonly HistoryEntry[], now: number): number | null {
  let soonest: number | null = null
  for (const e of entries) {
    const end = pickupEnds(e)
    if (end === null || now > end) continue
    soonest = soonest === null ? end : Math.min(soonest, end)
  }
  return soonest
}

