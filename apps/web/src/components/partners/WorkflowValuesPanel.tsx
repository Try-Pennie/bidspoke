'use client'

/**
 * The partners page's Workflow values tab (#2142, PM-15): each value the
 * Constants step emits for the partner, with its control, the exact name
 * workflows read it by, and which workflows read it, as the settled design
 * draws it (docs/design/partners-page.html, Workflow values).
 *
 * The readers come from GET /api/partners/:id/workflow-values, in three states
 * drawn differently (L10): still reading, failed (said once, with Try again,
 * and never as "no workflow"), and found. The controls are the form's own,
 * passed in by section, so what is edited and saved is unchanged.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { api, type PartnerWorkflowValue, type PartnerWorkflowValues } from '@/lib/api'
import { Button } from '@/components/ui/form'
import {
  accessLines, readerSentences, searchedSentence, sectionsOf, shadowSentences, type SectionKey, type ValueSection,
} from '@/app/(app)/partners/workflow-values-text'

type ReadState = { kind: 'none' } | { kind: 'loading' } | { kind: 'failed' } | { kind: 'found'; answer: PartnerWorkflowValues }

export type WorkflowValueControls = Partial<Record<Exclude<SectionKey, 'other' | 'active'>, ReactNode>>

interface Props {
  /** Null for a partner not saved yet: nothing is read. */
  partnerId: string | null
  slug: string
  /** Changes when the partner is saved, so the values as emitted are read again. */
  refreshKey: string
  isBuyer: boolean
  isSource: boolean
  /** The form's Active, which is this partner's entry in activeBidding. */
  isActive: boolean
  partnerName: string
  controls: WorkflowValueControls
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** A value with no control here, as the step emits it. */
function valueText(value: unknown): string {
  if (value === null || value === undefined) return 'Not set.'
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return entries.length === 0 ? 'Not set.' : entries.map(([k, v]) => `${k}: ${String(v)}`).join(', ')
  }
  return String(value)
}

function ReadersBlock({ values, searched }: { values: readonly PartnerWorkflowValue[]; searched: PartnerWorkflowValues['searched'] }) {
  if (values.length === 0) return null
  const lists = values.map(readerSentences)
  // The sell-off title and details are usually read by the same steps: said once when so.
  const groups = lists.every((l) => sameList(l, lists[0]))
    ? [{ lead: 'Read by', sentences: lists[0] }]
    : values.map((v, i) => ({ lead: v.kind === 'SellOffOfferTitle' ? 'The title is read by' : v.kind === 'SellOffOfferDetails' ? 'The details are read by' : 'Read by', sentences: lists[i] }))
  return (
    <>
      {groups.map((g) => (
        <div key={g.lead} className="text-sm text-gray-700">
          {g.sentences.length === 0
            ? <p>{searchedSentence(searched)}</p>
            : (
              <>
                <p className="mb-1 text-xs font-medium text-gray-600">{g.lead}</p>
                <ul className="space-y-0.5">{g.sentences.map((s) => <li key={s}>{s}</li>)}</ul>
              </>
            )}
        </div>
      ))}
    </>
  )
}

function ValueSectionView({ section, read, slug, isActive, partnerName, control }: {
  section: ValueSection; read: ReadState; slug: string; isActive: boolean; partnerName: string; control: ReactNode
}) {
  const answer = read.kind === 'found' ? read.answer : null
  const notSaved = answer !== null && control !== undefined && section.values.some((v) => !v.emitted)
  // A plain section, not a named region: the heading names the value, and the
  // control under it (the Click URL box) carries the same name for screen readers.
  return (
    <section data-value-section={section.key}>
      <h3 className="mb-4 text-xs font-semibold text-gray-500">{section.title}</h3>
      <div className="space-y-3">
        {control}
        {section.key === 'active' && (
          <p className="text-sm text-gray-700">{`${partnerName} is ${isActive ? 'active' : 'inactive'}, so workflows read ${isActive ? 'true' : 'false'}. Active is set on the Partner tab.`}</p>
        )}
        {control === undefined && section.key !== 'active' && section.values.map((v) => (
          <p key={v.constant_name} className="font-mono text-xs text-graphite [overflow-wrap:anywhere]">{valueText(v.value)}</p>
        ))}
        {answer && (
          <div className="space-y-1 text-sm text-gray-700">
            {accessLines(section.values, slug).map((l) => (
              <p key={l.code}>
                {`${l.lead} `}<code className="font-mono text-xs text-graphite [overflow-wrap:anywhere]">{l.code}</code>
                {' in a Code node and '}<code className="font-mono text-xs text-graphite [overflow-wrap:anywhere]">{l.template}</code>
                {` in a template${l.tail || '.'}`}
              </p>
            ))}
            {notSaved && <p>Until a value is saved, workflows find nothing under this name.</p>}
          </div>
        )}
        {answer && section.values.flatMap(shadowSentences).map((s) => <p key={s} className="text-sm text-amber-800">{s}</p>)}
        {answer && <ReadersBlock values={section.values} searched={answer.searched} />}
      </div>
    </section>
  )
}

export function WorkflowValuesPanel({ partnerId, slug, refreshKey, isBuyer, isSource, isActive, partnerName, controls }: Props) {
  const [read, setRead] = useState<ReadState>(partnerId ? { kind: 'loading' } : { kind: 'none' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!partnerId) { setRead({ kind: 'none' }); return }
    let cancelled = false
    setRead({ kind: 'loading' })
    // Through a promise, so a call that throws before answering is a failed read too, never an empty one.
    Promise.resolve()
      .then(() => api.partners.workflowValues(partnerId))
      .then((answer) => { if (!cancelled) setRead({ kind: 'found', answer }) })
      .catch(() => { if (!cancelled) setRead({ kind: 'failed' }) })
    return () => { cancelled = true }
  }, [partnerId, refreshKey, attempt])

  const sections = sectionsOf(read.kind === 'found' ? read.answer : null, { isBuyer, isSource })

  return (
    <div className="space-y-8">
      {read.kind === 'none' && <p className="text-sm text-gray-700">Which workflows read these values shows once the partner is saved.</p>}
      {read.kind === 'loading' && <p role="status" className="text-sm text-gray-600">Checking which workflows read these values…</p>}
      {read.kind === 'failed' && (
        <div role="alert" className="flex items-center gap-3 text-sm text-red-700">
          <span className="flex-1">Could not load which workflows read this. Try again.</span>
          <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
        </div>
      )}
      {sections.map((s) => (
        <ValueSectionView
          key={s.key === 'other' ? `other:${s.title}` : s.key}
          section={s}
          read={read}
          slug={slug}
          isActive={isActive}
          partnerName={partnerName}
          control={s.key === 'other' || s.key === 'active' ? undefined : controls[s.key]}
        />
      ))}
    </div>
  )
}
