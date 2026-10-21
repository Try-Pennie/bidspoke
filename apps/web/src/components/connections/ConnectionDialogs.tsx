'use client'

/**
 * The Connections page's dialogs (#2338, build PR 10; R19 to R21, D19 to
 * D21), on the app's one Dialog shell, drawn to
 * docs/design/connections-page.html with its 20px titles (round 26):
 *
 * - Reconnect <name>: what the connection names that the login is built from
 *   kept (Salesforce's client id), and each field of the login asked anew; Save
 *   with nothing typed checks the stored login again.
 * - Remove <name>?: what is lost, said, with Cancel and a red Remove; refused
 *   while a workflow uses it, naming each.
 * - The removal's notice, when the workflows server could not be told at once.
 * - Replace <name>: drawn as the design draws it and inert until build PR 12
 *   (R20), which makes its button replace.
 * - Leaving with something unsaved: Keep editing or Discard (L608).
 *
 * Escape, a click outside and a back gesture are each dialog's safe action:
 * they close a dialog with nothing typed, and leave one holding a typed login
 * or a running check open, so no incidental gesture discards anything. While a
 * change runs only the button that started it is held: Cancel closes the
 * dialog, and the change's answer still lands on the list.
 */
import { useId } from 'react'
import { Dialog } from '@/components/Dialog'
import { Button, SecretBlock, SecretInput, TextInput, TickRow } from '@/components/ui/form'
import { Select } from '@/components/ui/Select'
import type { LeaveRequest } from '@/lib/leave-guard'
import { reconnectFieldsOf, workingLabel, type FormService } from './add-form-model'
import { SaveLine } from './AddConnectionPanel'
import type { ConnectionView } from './connection-model'
import type { DialogState, UnsavedWork } from './connections-state'

type Open<K> = Extract<NonNullable<DialogState>, { kind: K }>

function Labelled({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="ad-field" data-part="field" data-field={label}>
      <label htmlFor={id} id={`${id}-label`} className="ad-label">{label}</label>
      {children}
    </div>
  )
}

export function ReconnectDialog({ dialog, connection, service, now, onField, onSave, onClose }: {
  dialog: Open<'reconnect'>
  connection: ConnectionView
  service: FormService
  now: number
  onField: (field: string, text: string) => void
  onSave: () => void
  onClose: () => void
}) {
  const base = useId()
  const { kept, asked } = reconnectFieldsOf(service.connection, connection.target)
  const saving = dialog.save.kind === 'saving'
  const typed = Object.values(dialog.values).some((v) => v.trim() !== '')
  return (
    <Dialog
      title={`Reconnect ${connection.name}`}
      className="cx-dialog cx-dialog-reconnect"
      // Nothing typed and nothing running: an incidental gesture closes it; otherwise it stays.
      onDismiss={() => { if (!saving && !typed) onClose() }}
      actions={
        <>
          <Button variant="primary" className="cx-btn cx-btn-sm" onClick={onSave} disabled={saving}>Save</Button>
          <Button variant="secondary" className="cx-btn-quiet" onClick={onClose}>Cancel</Button>
          <SaveLine save={dialog.save} now={now} label={workingLabel(service.name)} />
        </>
      }
    >
      <div className="ad-form">
        {kept.map((f) => (
          <Labelled key={f.key} id={`${base}-${f.key}`} label={f.label}>
            <TextInput id={`${base}-${f.key}`} value={f.value} onChange={() => {}} readOnly />
          </Labelled>
        ))}
        {/* The first box to type into takes the focus, rather than the kept value above it. */}
        {asked.map((f, i) => (
          <Labelled key={f.key} id={`${base}-${f.key}`} label={f.label}>
            {f.input === 'secret_block'
              ? <SecretBlock id={`${base}-${f.key}`} value={dialog.values[f.key] ?? ''} onChange={(t) => onField(f.key, t)} autoFocus={i === 0} />
              : f.input === 'secret'
                ? <SecretInput id={`${base}-${f.key}`} value={dialog.values[f.key] ?? ''} onChange={(t) => onField(f.key, t)} autoFocus={i === 0} />
                : <TextInput id={`${base}-${f.key}`} value={dialog.values[f.key] ?? ''} onChange={(t) => onField(f.key, t)} />}
          </Labelled>
        ))}
      </div>
    </Dialog>
  )
}

/** What Remove says is lost (R21, D21): the specific consequence, before anything is removed (L608). */
export const REMOVE_CONSEQUENCE = 'Its login is deleted from Bidspoke and cannot be brought back.'

export function RemoveDialog({ dialog, connection, now, onRemove, onClose }: {
  dialog: Open<'remove'>
  connection: ConnectionView
  now: number
  onRemove: () => void
  onClose: () => void
}) {
  const saving = dialog.save.kind === 'saving'
  // Refused because a workflow now uses it: the sentence names each, and there is nothing to press again.
  const used = connection.workflows.length > 0
  return (
    <Dialog
      warning
      title={`Remove ${connection.name}?`}
      description={REMOVE_CONSEQUENCE}
      className="cx-dialog cx-dialog-remove"
      onDismiss={() => { if (!saving) onClose() }}
      actions={
        <>
          <Button variant="secondary" className="cx-btn-quiet" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" className="cx-btn-dangerfill" onClick={onRemove} disabled={saving || used}>Remove</Button>
          <SaveLine save={dialog.save} now={now} label={`Removing ${connection.name}`} />
        </>
      }
    />
  )
}

export function RemovedDialog({ dialog, onClose }: { dialog: Open<'removed'>; onClose: () => void }) {
  return (
    <Dialog
      title={dialog.name}
      description={dialog.notice}
      className="cx-dialog cx-dialog-remove"
      onDismiss={onClose}
      actions={<Button variant="secondary" className="cx-btn-quiet" onClick={onClose}>Close</Button>}
    />
  )
}

/** Replace (R20), drawn as the design draws it; its Replace button replaces from build PR 12 (#1947). */
export function ReplaceDialog({ dialog, connection, candidates, onWith, onTick, onClose }: {
  dialog: Open<'replace'>
  connection: ConnectionView
  /** The other connections of its service, any of which can stand in for it. */
  candidates: readonly ConnectionView[]
  onWith: (id: string) => void
  onTick: (workflow: string) => void
  onClose: () => void
}) {
  const base = useId()
  const replacement = candidates.find((c) => c.id === dialog.with) ?? null
  const n = dialog.ticked.length
  return (
    <Dialog
      title={`Replace ${connection.name}`}
      className="cx-dialog cx-dialog-replace"
      onDismiss={onClose}
      actions={
        <>
          <Button variant="destructive" className="cx-btn-dangerfill" disabled={n === 0 || !replacement}>{`Replace in ${n} ${n === 1 ? 'workflow' : 'workflows'}`}</Button>
          <Button variant="secondary" className="cx-btn-quiet" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div className="ad-form">
        <Labelled id={`${base}-with`} label="Replace with">
          <Select id={`${base}-with`} value={dialog.with ?? ''} onChange={onWith} placeholder="Choose a connection" options={candidates.map((c) => ({ value: c.id, label: c.name }))} />
        </Labelled>
        <div data-part="replace-workflows">
          <span className="ad-label">In these workflows</span>
          {connection.workflows.map((w) => (
            <TickRow key={w.id} checked={dialog.ticked.includes(w.id)} onChange={() => onTick(w.id)} label={w.name} />
          ))}
        </div>
        {replacement && <p className="rp-sentence">Each ticked workflow gets a new version with {replacement.name}.</p>}
      </div>
    </Dialog>
  )
}

/** What the leave question says, by what leaving would lose (L608). */
export const LEAVE_WORDS: Readonly<Record<UnsavedWork, { title: string; description: string; leave: string }>> = {
  form: { title: 'The new connection is not saved', description: 'Leaving discards what is typed into its form.', leave: 'Discard' },
  form_checking: { title: 'The login is still being checked', description: 'Leaving now means not seeing whether the connection was saved.', leave: 'Leave' },
  login: { title: 'The new login is not saved', description: 'Leaving discards the login typed into Reconnect.', leave: 'Discard' },
  login_checking: { title: 'The new login is still being checked', description: 'Leaving now means not seeing whether it was saved.', leave: 'Leave' },
  removing: { title: 'The connection is still being removed', description: 'Leaving now means not seeing whether it was removed.', leave: 'Leave' },
}

/** Leaving with something unsaved (L608): Keep editing, or Discard and go. */
export function LeaveConnectionDialog({ request, unsaved, onKeepEditing }: { request: LeaveRequest; unsaved: UnsavedWork; onKeepEditing: () => void }) {
  const words = LEAVE_WORDS[unsaved]
  return (
    <Dialog
      warning
      title={words.title}
      description={words.description}
      className="cx-dialog"
      onDismiss={onKeepEditing}
      actions={
        <>
          <Button variant="secondary" className="cx-btn-quiet" onClick={onKeepEditing}>Keep editing</Button>
          <Button variant="destructive" className="cx-btn-dangerfill" onClick={request.proceed}>{words.leave}</Button>
        </>
      }
    />
  )
}
