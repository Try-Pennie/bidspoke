'use client'

/**
 * The partner delete box (#2140, PM-13): a pale red box at the foot of the
 * partner, which knows before anyone presses anything whether the partner can
 * be deleted and what a delete would remove.
 *
 * It reads the delete check when it opens and whenever refreshKey changes (the
 * page passes the partner's version, its profile's version and its sub-account
 * IDs, so its own saves and a live notice of anyone else's re-run it). Then one
 * of three things:
 *  - the check failed: no field, the failure, and Try again (L530);
 *  - something blocks the delete: no field, why, and that turning off Active
 *    stops it;
 *  - nothing blocks it: what it removes, the workflows it leaves without the
 *    partner, the secret it leaves, and a field that enables Delete only when
 *    DELETE is typed exactly.
 * The delete sends the check's fingerprint, and a refusal (a sale landed, or the
 * consequence moved) re-renders the box with the check as it is now.
 */
import { useEffect, useRef, useState } from 'react'
import { api, type PartnerDeleteCheck, type PartnerDeleted, type PartnerDeleteRefused } from '@/lib/api'
import { useElapsed } from '@/hooks/useElapsed'
import { Button, Outcome, TextInput } from '@/components/ui/form'
import { blockedSentences, consequenceSentence, secretSentence, workflowSentences } from './delete-copy'

export const DELETE_CHECK_FAILED = 'Could not check whether this partner can be deleted. Try again.'
const CONFIRM_WORD = 'DELETE'

type View =
  | { kind: 'checking' }
  | { kind: 'failed' }
  | { kind: 'ready'; check: PartnerDeleteCheck; notice: string | null }

function isRefusal(body: unknown): body is PartnerDeleteRefused {
  return typeof body === 'object' && body !== null && 'check' in body && (body as { error?: unknown }).error !== undefined
}

export function PartnerDeleteBox({ partner, refreshKey, onDeleted }: {
  partner: { id: string; name: string }
  /** Changes whenever what the delete would remove may have changed. */
  refreshKey: string
  onDeleted: (answer: PartnerDeleted) => void
}) {
  const [view, setView] = useState<View>({ kind: 'checking' })
  const [attempt, setAttempt] = useState(0)
  const [typed, setTyped] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // A state flag alone cannot stop a same tick double press (#495).
  const deletingRef = useRef(false)
  const checkingSeconds = useElapsed(view.kind === 'checking')
  const deletingSeconds = useElapsed(deleting)

  useEffect(() => {
    let cancelled = false
    setView({ kind: 'checking' })
    setTyped('')
    setDeleteError(null)
    api.partners.deleteCheck(partner.id)
      .then((check) => { if (!cancelled) setView({ kind: 'ready', check, notice: null }) })
      .catch(() => { if (!cancelled) setView({ kind: 'failed' }) })
    return () => { cancelled = true }
  }, [partner.id, refreshKey, attempt])

  async function handleDelete() {
    if (view.kind !== 'ready' || view.check.blockers.length > 0 || typed !== CONFIRM_WORD || deletingRef.current) return
    deletingRef.current = true
    setDeleting(true)
    setDeleteError(null)
    try {
      onDeleted(await api.partners.delete(partner.id, view.check.fingerprint))
    } catch (err) {
      const e = err as { status?: number; body?: unknown; message?: string }
      if (e.status === 409 && isRefusal(e.body)) {
        // Nothing was deleted. The box shows the partner as it is now.
        setTyped('')
        if (e.body.check === null) setView({ kind: 'failed' })
        else setView({ kind: 'ready', check: e.body.check, notice: e.body.error === 'consequence_changed' ? e.body.message : 'Nothing was deleted.' })
      } else {
        setDeleteError(e.message || 'The delete did not go through. Nothing was deleted.')
      }
    } finally {
      deletingRef.current = false
      setDeleting(false)
    }
  }

  const name = partner.name
  return (
    <section aria-labelledby="partner-delete-title" className="mt-10 space-y-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
      <h3 id="partner-delete-title" className="text-sm font-semibold text-graphite">Delete {name}</h3>

      {view.kind === 'checking' && (
        <Outcome state={{ kind: 'working', label: `Checking what deleting ${name} would remove`, startedAt: 0, now: checkingSeconds * 1000, stalledAfterMs: 20_000 }} />
      )}

      {view.kind === 'failed' && (
        <div className="flex items-center gap-3">
          <p role="alert" className="text-sm text-red-700">{DELETE_CHECK_FAILED}</p>
          <Button variant="secondary" onClick={() => setAttempt((a) => a + 1)}>Try again</Button>
        </div>
      )}

      {view.kind === 'ready' && (
        <>
          {view.notice && <p role="status" className="text-sm font-medium text-gray-800">{view.notice}</p>}
          {view.check.blockers.length > 0 ? (
            blockedSentences(name, view.check.blockers).map((s) => <p key={s} className="text-sm text-gray-700">{s}</p>)
          ) : (
            <>
              <p className="text-sm text-gray-700">{consequenceSentence(name, view.check.removes)}</p>
              {workflowSentences(view.check).map((s) => <p key={s} className="text-sm text-gray-700">{s}</p>)}
              {secretSentence(view.check.secret) && <p className="text-sm text-gray-700">{secretSentence(view.check.secret)}</p>}
              <div className="flex flex-col gap-1 pt-1">
                <label htmlFor="partner-delete-confirm" className="text-xs font-medium text-gray-700">Type DELETE to confirm</label>
                <div className="flex flex-wrap items-center gap-2">
                  <TextInput id="partner-delete-confirm" value={typed} onChange={setTyped} mono className="w-44" onEnter={() => { void handleDelete() }} />
                  <Button variant="destructive" disabled={typed !== CONFIRM_WORD} busy={deleting} onClick={() => { void handleDelete() }}>Delete {name}</Button>
                </div>
              </div>
              {deleting && <Outcome state={{ kind: 'working', label: `Deleting ${name}`, startedAt: 0, now: deletingSeconds * 1000, stalledAfterMs: 30_000 }} />}
              {deleteError && <p role="alert" className="text-sm text-red-700">{deleteError}</p>}
            </>
          )}
        </>
      )}
    </section>
  )
}
