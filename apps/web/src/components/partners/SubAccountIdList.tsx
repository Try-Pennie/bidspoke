'use client'

/**
 * A source partner's sub-account IDs, as the settled design draws them (#2327,
 * PM-24, docs/design/partners-page.html frame 21): one mono box per ID with a
 * grey minus, then "+ Add sub-account ID", which opens an empty box of its own.
 *
 * An ID is written the moment it is committed, by Enter or by leaving its box,
 * outside the versioned save (the form's callbacks do the writing). So the list
 * says a write is running (L608), says why one failed, and keeps what was typed
 * after a failure so Enter tries it again. A saved ID left emptied shows its
 * saved value again: an ID is taken away only by its minus.
 */
import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button, FieldError, TextInput } from '@/components/ui/form'
import { RemoveButton } from './RemoveButton'

export interface SubAccountId {
  /** Stable for the row: the stored mapping's id, or a pending one's place. */
  key: string
  uuid: string
}

interface Props {
  ids: readonly SubAccountId[]
  /** Writes a new ID; rejects with the reason when it is refused. */
  onAdd: (uuid: string) => Promise<void>
  /** Takes an ID away; rejects with the reason when it is refused. */
  onRemove: (key: string) => Promise<void>
  /**
   * Changes a saved ID to `uuid`, adding the new one before removing the old
   * (L5). Rejects with the reason when it is refused, and with an
   * `OldIdNotRemoved` when the new one was added but the old one stayed, so
   * both are listed as both are stored.
   */
  onChange: (key: string, uuid: string) => Promise<void>
}

/** The new ID was added and the old one could not be removed: both are stored. */
export class OldIdNotRemoved extends Error {}

type Working = { row: string; doing: 'Adding' | 'Changing' | 'Removing' } | null

let nextDraft = 0
const draftId = () => `draft-${++nextDraft}`
const message = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback)

export function SubAccountIdList({ ids, onAdd, onRemove, onChange }: Props) {
  /** What is typed in a saved ID's box, only while it differs from the saved one. */
  const [edits, setEdits] = useState<Record<string, string>>({})
  /** Boxes opened by the add link, not written yet. */
  const [drafts, setDrafts] = useState<Array<{ id: string; text: string }>>([])
  const [working, setWorking] = useState<Working>(null)
  const [error, setError] = useState<string | null>(null)
  const [focusDraft, setFocusDraft] = useState<string | null>(null)
  // One write at a time, checked synchronously: Enter and then leaving the box must not write twice.
  const busy = useRef(false)

  useEffect(() => {
    if (!focusDraft) return
    document.getElementById(`sub-account-${focusDraft}`)?.focus()
    setFocusDraft(null)
  }, [focusDraft])

  /** Runs one write, saying it is running and why it failed: 'done', 'failed', 'partly' (OldIdNotRemoved), or 'busy' when another is running. */
  const run = async (row: string, doing: NonNullable<Working>['doing'], write: () => Promise<void>, fallback: string): Promise<'done' | 'failed' | 'partly' | 'busy'> => {
    if (busy.current) return 'busy'
    busy.current = true
    setWorking({ row, doing })
    setError(null)
    try {
      await write()
      return 'done'
    } catch (err) {
      setError(message(err, fallback))
      return err instanceof OldIdNotRemoved ? 'partly' : 'failed'
    } finally {
      busy.current = false
      setWorking(null)
    }
  }

  const commitSaved = async (id: SubAccountId) => {
    if (busy.current) return
    const typed = (edits[id.key] ?? id.uuid).trim()
    const forget = () => setEdits((prev) => { const next = { ...prev }; delete next[id.key]; return next })
    if (typed === '' || typed === id.uuid) { forget(); return }
    const outcome = await run(id.key, 'Changing', () => onChange(id.key, typed), 'Failed to change the sub-account ID')
    // A refused change keeps what was typed to try again; one that added the new ID shows the old one as stored.
    if (outcome === 'done' || outcome === 'partly') forget()
  }

  const commitDraft = async (draft: { id: string; text: string }, leaving: boolean) => {
    if (busy.current) return
    const typed = draft.text.trim()
    const drop = () => setDrafts((prev) => prev.filter((d) => d.id !== draft.id))
    if (typed === '') { if (leaving) drop(); return }
    if (await run(draft.id, 'Adding', () => onAdd(typed), 'Failed to add the sub-account ID') === 'done') drop()
  }

  const remove = (id: SubAccountId) => {
    void run(id.key, 'Removing', () => onRemove(id.key), 'Failed to remove the sub-account ID')
  }

  return (
    <div className="space-y-1.5">
      {ids.map((id, i) => (
        <div key={id.key} className="grid grid-cols-[1fr_24px] items-center gap-2">
          <TextInput
            id={`sub-account-${id.key}`}
            aria-label={`Sub-account ID ${i + 1}`}
            value={edits[id.key] ?? id.uuid}
            onChange={(v) => { setEdits((prev) => ({ ...prev, [id.key]: v })); setError(null) }}
            onEnter={() => { void commitSaved(id) }}
            onBlur={() => { void commitSaved(id) }}
            disabled={working?.row === id.key}
            mono
            className="text-xs"
          />
          <RemoveButton label={`Remove sub-account ID ${i + 1}`} disabled={working !== null} onClick={() => remove(id)} />
        </div>
      ))}
      {drafts.map((draft, j) => (
        <div key={draft.id} className="grid grid-cols-[1fr_24px] items-center gap-2">
          <TextInput
            id={`sub-account-${draft.id}`}
            aria-label={drafts.length > 1 ? `New sub-account ID ${j + 1}` : 'New sub-account ID'}
            value={draft.text}
            onChange={(v) => { setDrafts((prev) => prev.map((d) => (d.id === draft.id ? { ...d, text: v } : d))); setError(null) }}
            onEnter={() => { void commitDraft(draft, false) }}
            onBlur={() => { void commitDraft(draft, true) }}
            disabled={working?.row === draft.id}
            mono
            className="text-xs"
          />
          {/* Nothing is written for a box not committed yet, so its minus only closes it. */}
          <RemoveButton
            label={drafts.length > 1 ? `Remove new sub-account ID ${j + 1}` : 'Remove new sub-account ID'}
            disabled={working?.row === draft.id}
            onClick={() => setDrafts((prev) => prev.filter((d) => d.id !== draft.id))}
          />
        </div>
      ))}
      <Button
        variant="quiet"
        onClick={() => { const id = draftId(); setDrafts((prev) => [...prev, { id, text: '' }]); setFocusDraft(id) }}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Add sub-account ID
      </Button>
      {working && <p role="status" className="text-xs text-hint">{working.doing} the sub-account ID…</p>}
      {error && <FieldError alert size="xs">{error}</FieldError>}
    </div>
  )
}
