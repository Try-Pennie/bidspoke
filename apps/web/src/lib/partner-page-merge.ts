/**
 * The one three way merge of the partners page (#2134, PM-3). PR4's live merge
 * reuses it, so it is pure and knows nothing of React.
 *
 * base is the page as loaded (or last saved), mine what is on screen, theirs
 * what a stale save's 409 says is stored now. Each unit is decided on its own:
 *
 * - A partner field is one unit per PartnerBody key. A whole JSON column such as
 *   outbound_field_mapping or response_classification is ONE field: two people
 *   editing different keys of one mapping is a question, not a union.
 * - A profile scalar is one unit per registry path.
 * - A row list merges at its row group (the registry's mergeGroup), never at the
 *   flattened row: windows by day, tiers by population, blackout dates and click
 *   routes each as one list. A flattened row's key holds an editable value, so
 *   moving a window's opening minute or a tier's lower bound would otherwise
 *   read as a delete plus an add.
 *
 * A unit only one side changed takes that side's value; the same value on both
 * sides is no question; different values on both sides is one conflict, decided
 * by `choices` (mine until chosen). The rebuilt profile is then judged as the
 * save judges it: parseProfileDocument, then validateProfile against the
 * partner rules as THIS merge leaves them (accept rules, click URL, routing
 * code) and the stored kind of their version. Any path either names becomes a
 * conflict carrying the reason, so an invalid combination is never offered as
 * a clean merge.
 */
import {
  documentToProfile, flattenProfileDocument, parseProfileDocument, registryPathOf, unflattenProfileDocument, validateProfile, DAYS_OF_WEEK,
  POPULATIONS, type BuyerProfileDocument, type Population, type Signal, type StoredKind,
} from '@bidspoke/buyer-profile'
import type { PartnerBody } from '@/lib/api'
import { PARTNER_BODY_KEYS, PROFILE_PREFIX, registryEntriesFor, type FieldEntry, type PartnerTab } from '@/app/(app)/partners/partner-draft'
import { POPULATION_LABELS } from '@/components/partners/buyer-profile/labels'

/** The two halves a page save writes. A profile the page never read is null. */
export interface PageHalves {
  partner: PartnerBody
  profile: BuyerProfileDocument | null
}

export type MergeSide = 'mine' | 'theirs'

/** One unit the merge decided, named as the page names it. */
export interface MergeUnit {
  /** Stable across merges of the same page, so a choice survives a second 409. */
  key: string
  tab: PartnerTab
  section: string
  label: string
}

export interface MergeConflict extends MergeUnit {
  base: unknown
  mine: unknown
  theirs: unknown
  /** Why the merge was refused at this unit (the validator's sentence), or null for an edit both made. */
  reason: string | null
  /** What a person chose, or null while undecided. */
  choice: MergeSide | null
}

export interface MergeSection {
  section: string
  tab: PartnerTab
  conflicts: MergeConflict[]
}

export interface MergeResult {
  /** Both halves with every one sided change applied and each conflict as chosen (mine while undecided). */
  merged: PageHalves
  /** Their changes, taken with no question. */
  autoTaken: MergeUnit[]
  /** My changes, kept with no question. */
  mineKept: MergeUnit[]
  /** The questions, grouped by section in registry order. */
  conflicts: MergeSection[]
}

/** JSON with object keys sorted, so a column the database reordered still compares equal. */
function canon(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]))
    return v === undefined ? null : v
  }
  return JSON.stringify(norm(value))
}

/** Whether two merge values are the same, whatever order the database left an object's keys in. */
export function sameMergeValue(a: unknown, b: unknown): boolean {
  return canon(a) === canon(b)
}

interface Unit {
  entry: FieldEntry
  /** The flattened profile paths this unit holds, in the document's own order; empty for a partner field. */
  rows: Array<[string, unknown]>
  value: unknown
}

/** The profile as merge units: scalars by registry path, rows by row group. */
function profileUnits(doc: BuyerProfileDocument, registry: readonly FieldEntry[]): Map<string, Unit> {
  const out = new Map<string, Unit>()
  for (const [path, value] of flattenProfileDocument(doc)) {
    const full = `${PROFILE_PREFIX}${path}`
    const entries = registryEntriesFor(full, registry)
    if (entries.length !== 1) throw new Error(`mergeThreeWay: ${full} matches ${entries.length} registry entries`)
    const entry = entries[0]
    const group = entry.mergeGroup
    if (!group) {
      out.set(full, { entry, rows: [[path, value]], value })
      continue
    }
    const key = group.by ? `${PROFILE_PREFIX}${group.name}@${String((value as Record<string, unknown>)[group.by])}` : `${PROFILE_PREFIX}${group.name}`
    const unit = out.get(key) ?? { entry, rows: [], value: [] }
    unit.rows.push([path, value])
    out.set(key, unit)
  }
  for (const unit of out.values()) {
    if (unit.entry.mergeGroup) unit.value = unit.rows.map(([path, value]) => (unit.entry.mergeGroup!.name === 'click_delivery.routes' ? { name: path.slice('click_delivery.routes['.length, -1), ...(value as object) } : value))
  }
  return out
}

/** A row group's on screen name: the list's label and, for a split list, the day or population. */
function unitLabel(key: string, entry: FieldEntry): string {
  const at = key.indexOf('@')
  if (at < 0) return entry.label
  const part = key.slice(at + 1)
  if (entry.mergeGroup?.by === 'day_of_week') return `${entry.label}, ${DAYS_OF_WEEK.find((d) => String(d.index) === part)?.label ?? `day ${part}`}`
  if (entry.mergeGroup?.by === 'population') return `${entry.label}, ${(POPULATIONS as readonly string[]).includes(part) ? POPULATION_LABELS[part as Population] : part}`
  return `${entry.label}, ${part}`
}

/** The merge units a refusal at a registry path is about: every unit whose registry entry that path matches. */
function unitsNamedBy(registryPath: string, keys: Iterable<string>, entryOf: (key: string) => FieldEntry, registry: readonly FieldEntry[]): string[] {
  const entries = registryEntriesFor(registryPath, registry)
  return [...keys].filter((k) => entries.includes(entryOf(k)))
}

/** A parser path (the document's own spelling) in the registry's spelling. */
function registryPathOfParserPath(path: string): string {
  const list = /^(windows|blackout_dates|tiers)\b/.exec(path)
  if (list) return `${PROFILE_PREFIX}${list[1]}[*]`
  if (path.startsWith('click_delivery.success_pattern')) return `${PROFILE_PREFIX}click_delivery.success_pattern`
  if (path.startsWith('click_delivery')) return `${PROFILE_PREFIX}click_delivery.routes[*]`
  return `${PROFILE_PREFIX}${path}`
}

export function mergeThreeWay(
  base: PageHalves,
  mine: PageHalves,
  theirs: PageHalves,
  registry: readonly FieldEntry[],
  choices: Readonly<Record<string, MergeSide>> = {},
): MergeResult {
  const units = new Map<string, { entry: FieldEntry; b?: Unit; m?: Unit; t?: Unit }>()
  const put = (key: string, entry: FieldEntry, side: 'b' | 'm' | 't', unit: Unit) => {
    const u = units.get(key) ?? { entry }
    u[side] = unit
    units.set(key, u)
  }
  for (const k of PARTNER_BODY_KEYS) {
    const entries = registryEntriesFor(k, registry)
    if (entries.length !== 1) throw new Error(`mergeThreeWay: ${k} matches ${entries.length} registry entries`)
    put(k, entries[0], 'b', { entry: entries[0], rows: [], value: base.partner[k] ?? null })
    put(k, entries[0], 'm', { entry: entries[0], rows: [], value: mine.partner[k] ?? null })
    put(k, entries[0], 't', { entry: entries[0], rows: [], value: theirs.partner[k] ?? null })
  }
  const profiles = base.profile && mine.profile && theirs.profile ? { b: base.profile, m: mine.profile, t: theirs.profile } : null
  if (profiles) {
    for (const side of ['b', 'm', 't'] as const) {
      for (const [key, unit] of profileUnits(profiles[side], registry)) put(key, unit.entry, side, unit)
    }
  }

  const empty = (key: string, entry: FieldEntry) => (entry.mergeGroup || key.startsWith(`${PROFILE_PREFIX}click_delivery`) ? [] : null)
  const decided = new Map<string, MergeSide>()
  const conflicts = new Map<string, MergeConflict>()
  const autoTaken: string[] = []
  const mineKept: string[] = []
  const unitOf = (key: string, entry: FieldEntry): MergeUnit => ({ key, tab: entry.tab, section: entry.section, label: unitLabel(key, entry) })
  const three = (key: string) => {
    const u = units.get(key)!
    const v = (x?: Unit) => (x ? x.value : empty(key, u.entry))
    return { b: v(u.b), m: v(u.m), t: v(u.t) }
  }

  for (const [key, u] of units) {
    const { b, m, t } = three(key)
    if (canon(m) === canon(t)) { decided.set(key, 'mine'); if (canon(m) !== canon(b)) mineKept.push(key); continue }
    if (canon(m) === canon(b)) { decided.set(key, 'theirs'); autoTaken.push(key); continue }
    if (canon(t) === canon(b)) { decided.set(key, 'mine'); mineKept.push(key); continue }
    conflicts.set(key, { ...unitOf(key, u.entry), base: b, mine: m, theirs: t, reason: null, choice: choices[key] ?? null })
  }

  const build = (sideFor: (key: string) => MergeSide): PageHalves => {
    const partner: Record<string, unknown> = {}
    for (const k of PARTNER_BODY_KEYS) {
      const value = (sideFor(k) === 'mine' ? mine.partner : theirs.partner)[k]
      if (value !== undefined) partner[k] = value
    }
    if (!profiles) return { partner: partner as PartnerBody, profile: mine.profile }
    const profileKeys = [...units.keys()].filter((k) => k.startsWith(PROFILE_PREFIX))
    if (profileKeys.every((k) => sideFor(k) === 'theirs' || canon(three(k).m) === canon(three(k).t))) {
      return { partner: partner as PartnerBody, profile: profiles.t }
    }
    // Their order first, so a merge that takes every row of theirs is theirs as stored.
    const order: string[] = []
    for (const side of [profiles.t, profiles.m]) {
      for (const key of profileUnits(side, registry).keys()) if (!order.includes(key)) order.push(key)
    }
    const paths = new Map<string, unknown>()
    for (const key of order) {
      const u = units.get(key)!
      const chosen = sideFor(key) === 'mine' ? u.m : u.t
      for (const [path, value] of chosen?.rows ?? []) paths.set(path, value)
    }
    const doc = unflattenProfileDocument(paths)
    return { partner: partner as PartnerBody, profile: { ...doc, partner_id: profiles.t.partner_id ?? profiles.m.partner_id, version: profiles.t.version } }
  }

  const defaultSide = (key: string): MergeSide => conflicts.get(key)?.choice ?? decided.get(key) ?? 'mine'
  // The questions are found on the merge as it stands before anyone chooses, so
  // the list does not change under a person as they answer it.
  const undecided = build((key) => (conflicts.has(key) ? 'mine' : decided.get(key) ?? 'mine'))

  if (profiles && undecided.profile) {
    const takesMine = [...units.keys()].some((k) => k.startsWith(PROFILE_PREFIX) && decided.get(k) === 'mine' && canon(three(k).m) !== canon(three(k).t))
    if (takesMine || (profiles.t.version ?? 0) > 0 || conflicts.size > 0) {
      const errors = refusals(undecided, profiles.t, theirs.partner)
      for (const { registryPath, message } of errors) {
        const named = unitsNamedBy(registryPath, units.keys(), (k) => units.get(k)!.entry, registry)
        const differing = named.filter((k) => canon(three(k).m) !== canon(three(k).t))
        const targets = differing.length > 0 ? differing : [...autoTaken, ...mineKept]
        for (const key of targets) {
          const existing = conflicts.get(key)
          if (existing) { existing.reason = existing.reason ? `${existing.reason} ${message}` : message; continue }
          const { b, m, t } = three(key)
          conflicts.set(key, { ...unitOf(key, units.get(key)!.entry), base: b, mine: m, theirs: t, reason: message, choice: choices[key] ?? null })
        }
      }
    }
  }

  const sectionOrder = [...new Set(registry.map((e) => e.section))]
  const entryIndex = (key: string) => registry.indexOf(units.get(key)!.entry)
  const sorted = [...conflicts.values()].sort((a, b) => sectionOrder.indexOf(a.section) - sectionOrder.indexOf(b.section) || entryIndex(a.key) - entryIndex(b.key) || a.key.localeCompare(b.key))
  const sections: MergeSection[] = []
  for (const c of sorted) {
    const last = sections[sections.length - 1]
    if (last && last.section === c.section) last.conflicts.push(c)
    else sections.push({ section: c.section, tab: c.tab, conflicts: [c] })
  }
  const named = (keys: string[]) => keys.filter((k) => !conflicts.has(k)).sort((a, b) => entryIndex(a) - entryIndex(b) || a.localeCompare(b)).map((k) => unitOf(k, units.get(k)!.entry))

  return {
    merged: build(defaultSide),
    autoTaken: named(autoTaken),
    mineKept: named(mineKept),
    conflicts: sections,
  }
}

/** What the save would refuse in a merged page, each in the registry's spelling with its sentence. */
function refusals(merged: PageHalves, theirsProfile: BuyerProfileDocument, theirsPartner: PartnerBody): Array<{ registryPath: string; message: string }> {
  const parsed = parseProfileDocument(merged.profile)
  if (!parsed.ok) return parsed.errors.map((e) => ({ registryPath: registryPathOfParserPath(e.path), message: e.message }))
  const doc = parsed.document
  const accept = Array.isArray(merged.partner.accept_signals) ? (merged.partner.accept_signals as Signal[]) : []
  const stored: StoredKind | null = (theirsProfile.version ?? 0) > 0 && theirsProfile.sold_on !== null
    ? { soldOn: theirsProfile.sold_on, tierCount: theirsProfile.tiers.length, acceptRuleCount: Array.isArray(theirsPartner.accept_signals) ? theirsPartner.accept_signals.length : 0 }
    : null
  const validation = validateProfile(documentToProfile({ ...doc, partner_id: doc.partner_id ?? '' }), {
    acceptSignals: accept,
    clickUrl: typeof merged.partner.click_url === 'string' && merged.partner.click_url !== '' ? merged.partner.click_url : null,
    externalRoutingCode: typeof merged.partner.external_routing_code === 'number' ? merged.partner.external_routing_code : null,
  }, stored)
  if (validation.ok) return []
  const routeNames = doc.click_delivery?.routes.map((r) => r.name) ?? []
  return validation.errors.map((e) => ({ registryPath: registryPathOf(e.path, routeNames), message: e.message }))
}

/** How many questions are still unanswered. */
export function unansweredCount(result: MergeResult): number {
  return result.conflicts.reduce((n, s) => n + s.conflicts.filter((c) => c.choice === null).length, 0)
}
