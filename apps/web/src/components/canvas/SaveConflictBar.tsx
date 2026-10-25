'use client'

/**
 * A canvas save refused because someone else saved the workflow after the
 * canvas loaded it (#2599, settled design docs/design/canvas-save-conflict.html).
 * The canvas's red save error strip names who saved and when (R1), with Load
 * their version and Save mine over theirs on its right in the toolbar's own
 * button style (R2). Each asks first in the shared warning dialog, naming what
 * is lost (R3, R4). Its own component because WorkflowCanvas cannot be mounted
 * in jsdom (#737); the canvas decides when it shows and what each answer does.
 */
import { useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { Dialog } from '@/components/Dialog'
import { Button } from '@/components/ui/form'
import { loadTheirsDialog, saveOverDialog, staleWorkflowSentence, type StaleSave } from '@/lib/workflow-save-conflict'
import { TOOLBAR_BUTTON, TOOLBAR_BUTTON_REST } from './toolbar-button'

const ACTION = `${TOOLBAR_BUTTON} ${TOOLBAR_BUTTON_REST} bg-white whitespace-nowrap shrink-0`

type Asking = 'save-over' | 'load-theirs'

export function SaveConflictBar({ stale, onLoadTheirs, onSaveOver }: {
  stale: StaleSave
  /** Replaces the canvas with the stored version. Reports its own failure; never throws. */
  onLoadTheirs: () => Promise<void>
  /** Saves the canvas naming the version the refusal showed. Reports its own failure; never throws. */
  onSaveOver: () => Promise<void>
}) {
  const [asking, setAsking] = useState<Asking | null>(null)
  const [busy, setBusy] = useState(false)

  const words = asking === 'save-over' ? saveOverDialog(stale) : asking === 'load-theirs' ? loadTheirsDialog(stale) : null

  async function answer() {
    if (!asking) return
    setBusy(true)
    try {
      await (asking === 'save-over' ? onSaveOver() : onLoadTheirs())
    } finally {
      setBusy(false)
      setAsking(null)
    }
  }

  return (
    <>
      <div data-part="save-conflict" className="flex items-center gap-2 bg-red-50 px-4 py-2 text-xs text-red-600">
        <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
        <span>{staleWorkflowSentence(stale)}</span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className={ACTION} onClick={() => setAsking('load-theirs')}>Load their version</button>
          <button type="button" className={ACTION} onClick={() => setAsking('save-over')}>Save mine over theirs</button>
        </div>
      </div>
      {words && (
        <Dialog
          warning
          title={words.title}
          description={words.description}
          onDismiss={() => { if (!busy) setAsking(null) }}
          actions={
            <>
              <Button variant="secondary" onClick={() => setAsking(null)} disabled={busy}>Cancel</Button>
              <Button variant="destructive" onClick={() => { void answer() }} busy={busy}>{words.action}</Button>
            </>
          }
        />
      )}
    </>
  )
}
