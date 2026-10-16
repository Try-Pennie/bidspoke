/**
 * The words of the partner delete box (#2140, PM-13), from the delete check's
 * structured answer. One place, so the box, its blocked state and the refusal
 * after a press say the same thing the same way (L118).
 */
import { formatWhole } from './buyer-profile/labels'
import type { DependentNoun, PartnerDeleteBlocker, PartnerDeleteCheck, PartnerDeleteTable, PartnerDeleteWorkflow } from '@/lib/api'

// Counts in the one whole number spelling the partners page uses (6,339).
const n = formatWhole

/** "its buyer profile" for one, "2 sub-account IDs" for any other count. */
export function countPhrase(rows: number, noun: DependentNoun): string {
  return rows === 1 ? `its ${noun.one}` : `${n(rows)} ${noun.many}`
}

/** "a, b and c". */
export function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** What the delete removes, naming only what this partner has. */
export function consequenceSentence(name: string, removes: readonly PartnerDeleteTable[]): string {
  const deleted = removes.filter((r) => r.kind === 'deleted').map((r) => countPhrase(r.rows, r.noun))
  const cleared = removes.filter((r) => r.kind === 'cleared').map((r) => `${n(r.rows)} ${r.rows === 1 ? r.noun.one : r.noun.many}`)
  const first = `Removes ${joinAnd([name, ...deleted])}. This cannot be undone.`
  // A SET NULL key keeps its rows and drops their link; none exists today, and it is still said.
  return cleared.length === 0 ? first : `${first} It also unlinks ${joinAnd(cleared)}, which stay.`
}

function blockerPhrase(b: PartnerDeleteBlocker): string {
  if (b.kind === 'rows') return `${n(b.rows)} ${b.rows === 1 ? `${b.noun.one} refers` : `${b.noun.many} refer`} to it`
  if (b.kind === 'ledger_unmirrored') return `${n(b.count)} ${b.count === 1 ? 'sale is' : 'sales are'} not yet recorded`
  return `${n(b.count)} ${b.count === 1 ? 'sale is' : 'sales are'} awaiting settlement`
}

/** Why the partner cannot be deleted, and what to do instead. */
export function blockedSentences(name: string, blockers: readonly PartnerDeleteBlocker[]): [string, string] {
  return [`${name} cannot be deleted: ${joinAnd(blockers.map(blockerPhrase))}.`, 'To stop offering it leads, turn off Active.']
}

function workflowList(workflows: readonly PartnerDeleteWorkflow[]): string {
  return joinAnd(workflows.map((w) => (w.is_active ? w.name : `${w.name} (switched off)`)))
}

/** The workflows a delete leaves without the partner, one sentence per way they use it. */
export function workflowSentences(check: PartnerDeleteCheck): string[] {
  const name = check.partner.name
  const out: string[] = []
  if (check.workflows_naming_partner.length > 0) {
    const ws = check.workflows_naming_partner
    out.push(`${workflowList(ws)} ${ws.length === 1 ? 'names' : 'name'} ${name} in a node and will not find it after the delete.`)
  }
  const byName = check.workflows_reading_values.filter((w) => w.reads === 'by_name')
  if (byName.length > 0) {
    const values = joinAnd([...new Set(byName.flatMap((w) => w.values))])
    out.push(`${workflowList(byName)} ${byName.length === 1 ? 'reads' : 'read'} ${values} and will read nothing for ${name} after the delete.`)
  }
  const every = check.workflows_reading_values.filter((w) => w.reads === 'every_partner')
  if (every.length > 0) {
    const maps = joinAnd([...new Set(every.flatMap((w) => w.values))])
    out.push(`${workflowList(every)} ${every.length === 1 ? 'reads' : 'read'} ${maps} for every partner; after the delete it holds nothing for ${name}.`)
  }
  return out
}

/** The Worker secret a delete leaves in place. */
export function secretSentence(secret: PartnerDeleteCheck['secret']): string | null {
  if (!secret) return null
  const others = secret.other_partners === 0
    ? 'No other partner names it.'
    : `${n(secret.other_partners)} other ${secret.other_partners === 1 ? 'partner names' : 'partners name'} it.`
  return `The Worker secret ${secret.name} stays. ${others}`
}
