/**
 * The words of the partners page save bar and its leave dialog (#2138, PM-4,
 * PM-5, PM-6), each derived from what it describes: a change is named by its
 * registry label through changedUnits, a click delivery change by what it does
 * (clickDeliveryConsequences), and a refusal by the field's label and tab.
 */
import type { SoldOn } from '@bidspoke/buyer-profile'
import { CLICK_FIELD_LABELS } from '@/components/partners/buyer-profile/labels'
import type { LeaveDestination } from '@/lib/leave-guard'
import type { MergeUnit } from '@/lib/partner-page-merge'
import { PROFILE_PREFIX, registryEntriesFor } from './partner-draft'
import { TAB_LABELS, type PageProblem } from './partner-tabs'

/** A save whose answer was lost: not known to have landed, and never called failed (L766). */
export const UNCONFIRMED = 'Not confirmed yet, checking.'
export const UNCONFIRMED_GAVE_UP = 'Still not confirmed. It may have saved. Reload to see what is stored.'
export const UNCONFIRMED_DISCARD_REASON = 'Your last save may still land. Wait for it to be confirmed before discarding.'
/**
 * Once checking has stopped (two minutes, no evidence), Discard is open again
 * (L665: nothing left running could clear the wait), saying what it cannot undo.
 */
export const UNCONFIRMED_DISCARD_GAVE_UP = 'Discarding clears what is on screen, not the save, which may already be stored.'

/** Where an unconfirmed save stands: still being checked, or checking has stopped. */
export type UnconfirmedState = 'checking' | 'gave-up' | null
/** A 401 held by the leave guard: the draft stays on screen. */
export const SESSION_EXPIRED = 'Not saved: your session has expired. Sign in again in a new tab, then press Try again. Your changes are still here.'
/** A 403 held by the leave guard. */
export const ACCESS_REMOVED = 'Not saved: your access to Bidspoke has been removed. Your changes are still here; copy anything you need before you leave.'

/** "A", "A and B", "A, B and C". */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

const isClickDelivery = (u: MergeUnit) => u.key.startsWith(`${PROFILE_PREFIX}click_delivery`)

/**
 * The units as the form names them for this buyer: a click buyer's cap counts
 * clicks, so it is named for them (#1541, L118), as its field is.
 */
export function namedAsShown(units: readonly MergeUnit[], soldOn: SoldOn | null | undefined): MergeUnit[] {
  if (soldOn !== 'click') return [...units]
  return units.map((u) => {
    const clickLabel = u.key.startsWith(PROFILE_PREFIX) ? CLICK_FIELD_LABELS[u.key.slice(PROFILE_PREFIX.length)] : undefined
    return clickLabel ? { ...u, label: clickLabel } : u
  })
}

/**
 * "1 unsaved change: Name". A click delivery change is said as what it does
 * (PM-6), in place of its label, beside the one Save; one that moves no click
 * keeps its label.
 */
export function unsavedSentence(units: readonly MergeUnit[], consequences: readonly string[]): string {
  if (units.length === 0) return 'Unsaved changes'
  const named = consequences.length > 0 ? units.filter((u) => !isClickDelivery(u)) : units
  const labels = andList(named.map((u) => u.label))
  // Each consequence is a sentence of its own, already ending in a full stop.
  const said = consequences.length === 0 ? labels : labels === '' ? consequences.join(' ') : `${labels}. ${consequences.join(' ')}`
  return `${units.length} unsaved change${units.length === 1 ? '' : 's'}: ${said}`
}

/**
 * "Nothing saved: fix Click URL in Workflow values." Null when no refused field
 * is on a tab. "in", not the design's "on", because a label can end in "on"
 * (Sold on). The reason is beside the field, marked red (PM-12).
 */
export function refusedSentence(problems: readonly PageProblem[], soldOn?: SoldOn | null): string | null {
  const onTabs = problems.filter((p) => p.tab !== null && p.registryPath !== null)
  const first = onTabs[0]
  if (!first || !first.tab || !first.registryPath) return null
  const entry = registryEntriesFor(first.registryPath)[0]
  const label = entry ? namedAsShown([{ key: entry.pattern, label: entry.label, tab: entry.tab, section: entry.section }], soldOn)[0].label : 'the field marked in red'
  const more = onTabs.length > 1 ? `, and ${onTabs.length - 1} more` : ''
  return `Nothing saved: fix ${label} in ${TAB_LABELS[first.tab]}${more}.`
}

export function leaveTitle(who: string, units: readonly MergeUnit[], unconfirmed: boolean): string {
  if (units.length === 0 && unconfirmed) return `Leave ${who} before its save is confirmed?`
  if (units.length === 0) return `Leave ${who} with unsaved changes?`
  return `Leave ${who} with ${units.length === 1 ? 'an unsaved change' : `${units.length} unsaved changes`}?`
}

export function leaveDescription(units: readonly MergeUnit[], unconfirmed: UnconfirmedState): string {
  const changed = units.length === 0 ? (unconfirmed ? '' : 'Your changes are not saved.') : `You changed ${andList(units.map((u) => u.label))} and have not saved ${units.length === 1 ? 'it' : 'them'}.`
  const note = unconfirmed === 'checking' ? UNCONFIRMED_DISCARD_REASON : unconfirmed === 'gave-up' ? UNCONFIRMED_DISCARD_GAVE_UP : ''
  return [changed, note].filter((s) => s !== '').join(' ')
}

/** The two leaving buttons, naming where the person was going (PM-5). */
export function leaveActionWords(destination: LeaveDestination): { discard: string; save: string } {
  const where = destination.kind === 'partner' || destination.kind === 'page' ? `open ${destination.name}`
    : destination.kind === 'back' ? 'go back'
      : destination.kind === 'close' ? 'close'
        : 'sign out'
  return { discard: `Discard and ${where}`, save: `Save and ${where}` }
}
