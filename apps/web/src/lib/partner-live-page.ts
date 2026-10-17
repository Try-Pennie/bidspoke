/**
 * The partners page's rules for the live channel (#2135, PR4 of #2114), apart
 * from React: which notice the page acts on, the live misses it reports,
 * the "Changed directly in the database" notes, and the sentences said about
 * another person's save.
 */
import { MAX_REPORTED_GAP_MS, type LiveMissReportBody, type PartnerPageNotice, type PartnerPageVersions } from '@bidspoke/partner-page-live'
import { BIDDING_PICKUP, directChangeSentence } from './bidding-pickup'
import { formatEtClock } from './dates'
import { PARTNER_FIELD_REGISTRY, PROFILE_PREFIX, registryEntriesFor } from '@/app/(app)/partners/partner-draft'
import type { MergeResult, MergeUnit } from './partner-page-merge'

/** How often the page asks for the versions while its draft is dirty (the plan's delivery probe, L106). */
export const PROBE_EVERY_MS = 60_000

let clientId: string | null = null

/**
 * This browser tab, sent as client_id on every page save so the tab knows its
 * own notice (L747). One per module instance, which is one per tab.
 */
export function tabClientId(): string {
  if (clientId === null) clientId = crypto.randomUUID()
  return clientId
}

/** The two versions the page holds; a profile it never read is null and is not compared. */
export interface HeldVersions {
  partnerVersion: number
  profileVersion: number | null
}

export type NoticeAction = 'ignore' | 'echo' | 'resolves_unknown' | 'uuids' | 'deleted' | 'already_held' | 'refetch'

export interface NoticeContext {
  partnerId: string
  clientId: string
  /** Every save id this tab has sent. */
  ownSaveIds: ReadonlySet<string>
  /** A press of Save that got no answer, so whether it landed is unknown. */
  unknownSaveId: string | null
  known: HeldVersions
}

/**
 * What the open page does with a notice. Its own save is known by this tab's
 * client_id together with a save_id it sent, never by who saved (L747): the
 * same person in another tab is merged like anyone else. A save whose outcome
 * is unknown is never an echo: the notice carrying its save_id says it landed.
 */
export function classifyNotice(n: PartnerPageNotice, c: NoticeContext): NoticeAction {
  if (n.kind === 'monitor' || n.partnerId !== c.partnerId) return 'ignore'
  if (c.unknownSaveId !== null && n.saveId === c.unknownSaveId) return 'resolves_unknown'
  if (n.clientId === c.clientId && n.saveId !== null && c.ownSaveIds.has(n.saveId)) return 'echo'
  if (n.kind === 'deleted') return 'deleted'
  // partner_uuid_map has no version: its notice carries the pair as it stands.
  if (n.kind === 'uuids') return 'uuids'
  // A version it cannot compare is read again: the fail safe side (L50).
  const partnerAhead = n.partnerVersion === null || n.partnerVersion > c.known.partnerVersion
  const profileAhead = c.known.profileVersion !== null && (n.profileVersion === null ? n.kind === 'profile' : n.profileVersion > c.known.profileVersion)
  return partnerAhead || profileAhead ? 'refetch' : 'already_held'
}

/** Whether the probe found a version past the one the page holds. */
export function probeFindsGap(known: HeldVersions, v: PartnerPageVersions): boolean {
  return v.partnerVersion > known.partnerVersion || (known.profileVersion !== null && v.profileVersion > known.profileVersion)
}

/**
 * The miss a probe reports: direct_sql when the change had no actor, otherwise
 * delivery. A gap longer than the route accepts (a day) is sent as a day: the
 * page heard nothing for at least that long, which is the measurement.
 */
export function liveMissReport(v: PartnerPageVersions, known: HeldVersions, lastNoticeAt: number | null, now: number): LiveMissReportBody {
  return {
    partner_id: v.partnerId,
    cause: v.latestChange?.direct ? 'direct_sql' : 'delivery',
    noticed: heardOf(known),
    observed: { partner_version: v.partnerVersion, profile_version: v.profileVersion },
    since_last_notice_ms: gapSinceLastNotice(lastNoticeAt, now),
  }
}

/** The versions the page held, as both miss reports send them. */
function heardOf(known: HeldVersions): LiveMissReportBody['noticed'] {
  return { partner_version: known.partnerVersion, profile_version: known.profileVersion }
}

/** How long the page has heard no notice, as both miss reports send it; null when it never heard one. */
function gapSinceLastNotice(lastNoticeAt: number | null, now: number): number | null {
  return lastNoticeAt === null ? null : Math.min(Math.max(0, now - lastNoticeAt), MAX_REPORTED_GAP_MS)
}

/**
 * A join refused because the day's partition did not exist yet (#2288): what
 * the page last heard, and nothing observed, since no probe ran.
 */
export function partitionRefusalReport(partnerId: string, known: HeldVersions, lastNoticeAt: number | null, now: number): LiveMissReportBody {
  return {
    partner_id: partnerId,
    cause: 'missing_partition',
    noticed: heardOf(known),
    observed: { partner_version: null, profile_version: null },
    since_last_notice_ms: gapSinceLastNotice(lastNoticeAt, now),
  }
}

/** A line shown on the page's sections; no section means the top of the page. */
export interface SectionNote {
  sections: string[]
  text: string
}

export interface DirectNote extends SectionNote {
  expiresAt: number
}

/** A profile table a hand write names, as the list it holds on the page. */
const PROFILE_TABLE_PATHS: Record<string, string> = {
  buyer_operating_windows: 'windows[0]',
  buyer_blackout_dates: 'blackout_dates[0]',
  buyer_pricing_tiers: 'tiers[0]',
}

/** The registry sections a changed column or path belongs to, in registry order. */
function sectionsOf(fields: readonly string[], half: 'partner' | 'profile'): string[] {
  const found = new Set<string>()
  for (const field of fields) {
    const path = half === 'partner' ? field : `${PROFILE_PREFIX}${PROFILE_TABLE_PATHS[field] ?? field}`
    const exact = registryEntriesFor(path)
    const entries = exact.length > 0 ? exact : PARTNER_FIELD_REGISTRY.filter((e) => e.pattern.startsWith(`${path}.`) || e.pattern.startsWith(`${path}[`))
    for (const e of entries) {
      if (half === 'profile' ? e.pattern.startsWith(PROFILE_PREFIX) : !e.pattern.startsWith(PROFILE_PREFIX)) found.add(e.section)
    }
  }
  const order = [...new Set(PARTNER_FIELD_REGISTRY.map((e) => e.section))]
  return [...found].sort((a, b) => order.indexOf(a) - order.indexOf(b))
}

/**
 * The notes for a change made outside the page (#2135, L126): read from the
 * newest audit row of each half, so a page opened after the edit shows it too,
 * and gone once the half's BIDDING_PICKUP bound has passed from changed_at.
 */
export function directChangeNotes(v: PartnerPageVersions, now: number): DirectNote[] {
  const notes: DirectNote[] = []
  for (const half of ['partner', 'profile'] as const) {
    const change = v.newest[half]
    if (!change?.direct) continue
    const at = Date.parse(change.changedAt)
    const minutes = half === 'partner' ? BIDDING_PICKUP.partnerConstantsMinutes : BIDDING_PICKUP.buyerProfilesMinutes
    const expiresAt = at + minutes * 60_000
    if (!(now < expiresAt)) continue
    notes.push({ sections: sectionsOf(change.fields, half), text: directChangeSentence(formatEtClock(change.changedAt), half), expiresAt })
  }
  return notes
}

/** Who saved, as the partner row names them. */
export function savedByName(p: { updated_by_name: string | null; updated_by_email: string | null }): string | null {
  return p.updated_by_name ?? p.updated_by_email?.split('@')[0] ?? null
}

const listOf = (labels: string[]) => (labels.length <= 1 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`)

/** The save bar's sentence when another person's save changed fields this person is editing. */
export function liveConflictSentence(name: string | null, fields: number): string {
  return `${name ?? 'Someone else'} changed ${fields} ${fields === 1 ? 'field' : 'fields'} you are editing. You choose when you save.`
}

/** The save bar's sentence when another person's save merged with nothing to ask. */
export function liveTakenSentence(name: string | null, taken: readonly MergeUnit[]): string {
  const who = name ?? 'Someone else'
  if (taken.length === 0) return `${who} saved this partner, with no change to anything shown here.`
  // A field no tab draws (the registry's offPage) is never said to be on screen.
  const shown = taken.filter((u) => !offPage(u))
  const hidden = taken.filter(offPage)
  const parts = [
    shown.length > 0 ? `Their ${shown.length === 1 ? 'change' : 'changes'} to ${listOf(shown.map((u) => u.label))} ${shown.length === 1 ? 'is' : 'are'} on screen.` : null,
    hidden.length > 0 ? `They ${shown.length > 0 ? 'also ' : ''}changed ${listOf(hidden.map((u) => u.label))}.` : null,
  ].filter((p): p is string => p !== null)
  return `${who} saved this partner. ${parts.join(' ')}`
}

/** Whether a merge unit is a field no tab draws a control for. */
const offPage = (u: MergeUnit): boolean => registryEntriesFor(u.key).some((e) => e.offPage === true)

/** "Updated by <Name>: <fields>." on each section that took their change, for the fields a tab draws. */
export function updatedByNotes(name: string | null, taken: readonly MergeUnit[]): SectionNote[] {
  const bySection = new Map<string, string[]>()
  for (const u of taken.filter((t) => !offPage(t))) bySection.set(u.section, [...(bySection.get(u.section) ?? []), u.label])
  return [...bySection].map(([section, labels]) => ({ sections: [section], text: `Updated by ${name ?? 'someone else'}: ${listOf(labels)}.` }))
}

/**
 * The questions of a merge, kept to those a live notice found (plus any the
 * validator raised): a field this person edited after seeing their value is
 * an informed edit, not a question.
 */
export function askedOnly(result: MergeResult, keys: readonly string[]): MergeResult {
  const held = new Set(keys)
  return {
    ...result,
    conflicts: result.conflicts
      .map((s) => ({ ...s, conflicts: s.conflicts.filter((c) => held.has(c.key) || c.reason !== null) }))
      .filter((s) => s.conflicts.length > 0),
  }
}
