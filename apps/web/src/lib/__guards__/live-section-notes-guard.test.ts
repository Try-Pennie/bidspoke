/**
 * Every section of the partners page's field registry has a place on the page
 * that shows its live notes (#2135): "Updated by <Name>" and "Changed directly
 * in the database at". A note is keyed by the registry section of the field it
 * is about (partner-draft.ts), and a block shows it through LiveSectionNote
 * (or PartnerForm's Section, whose heading names the section, or whose
 * liveSections names it). A registry section nothing shows would drop its note
 * silently, so this enumerates from the registry, the source the notes come
 * from (L96), not from the headings.
 *
 * Seen failing: with the Caps LiveSectionNote removed from BuyerProfileSection
 * (it named "Caps" as missing).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listFiles, WEB_SRC } from '../__tests__/_scan-utils'
import { PARTNER_FIELD_REGISTRY } from '@/app/(app)/partners/partner-draft'
import { SECTION_LABELS } from '@/components/partners/buyer-profile/labels'

const ROOTS = [path.join(WEB_SRC, 'app/(app)/partners'), path.join(WEB_SRC, 'components/partners')]

/** The section names one source file shows notes for. */
export function sectionsShownIn(src: string): string[] {
  const out: string[] = []
  const item = (raw: string) => {
    const t = raw.trim()
    const literal = /^['"]([^'"]+)['"]$/.exec(t)
    if (literal) return literal[1]
    const label = /^SECTION_LABELS\.(\w+)$/.exec(t)
    if (label && label[1] in SECTION_LABELS) return SECTION_LABELS[label[1] as keyof typeof SECTION_LABELS]
    throw new Error(`a live section name the guard cannot read: ${t}`)
  }
  for (const m of src.matchAll(/(?:liveSections|<LiveSectionNote\s+sections)=\{\[([^\]]*)\]\}/g)) {
    for (const part of m[1].split(',').filter((p) => p.trim() !== '')) out.push(item(part))
  }
  // A Section whose heading is the registry section, with no liveSections of its own.
  for (const m of src.matchAll(/<Section\s+title="([^"]+)"([^>]*)>/g)) if (!m[2].includes('liveSections')) out.push(m[1])
  return out
}

describe('every registry section shows its live notes somewhere (#2135)', () => {
  it('each section the registry names is shown by a LiveSectionNote or a Section', () => {
    const shown = new Set(ROOTS.flatMap((root) => listFiles(root, { exts: ['.tsx'] })).flatMap((f) => sectionsShownIn(readFileSync(f, 'utf8'))))
    const missing = [...new Set(PARTNER_FIELD_REGISTRY.map((e) => e.section))].filter((s) => !shown.has(s))
    expect(missing).toEqual([])
  })

  it('reads literals, SECTION_LABELS and plain Section headings, and refuses what it cannot read', () => {
    expect(sectionsShownIn(`<LiveSectionNote sections={['Caps', SECTION_LABELS.tiers]} />`)).toEqual(['Caps', 'Pricing'])
    expect(sectionsShownIn(`<Section title="Identity">`)).toEqual(['Identity'])
    expect(sectionsShownIn(`<Section title="Click URL" liveSections={['Endpoints']}>`)).toEqual(['Endpoints'])
    expect(() => sectionsShownIn(`<LiveSectionNote sections={[someName]} />`)).toThrow(/cannot read/)
  })
})
