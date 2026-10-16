'use client'

export const runtime = 'edge'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import type { Partner, PartnerBody, PartnerPageSaveRequest, PartnerPageSaved, PartnerPageStale } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import { Plus, CircleCheck, CircleOff, AlertTriangle } from 'lucide-react'
import { Skeleton } from '@/components/ui/Skeleton'
import { Button } from '@/components/ui/form'
import { ProblemMark } from '@/components/ui/ProblemMark'
import PartnerForm, { UNSAVED_CHANGES_MESSAGE, type PartnerSaveResult } from './PartnerForm'
import { partnersUrl, tabFromParam } from './partner-tabs'
import { groupPartners } from './partner-list'
import type { PartnerTab } from './partner-draft'

/**
 * Mirror the page's state into its URL (#2137) through the one URL builder,
 * with replaceState: no history entry and no server round trip, and Next keeps
 * useSearchParams in step with it.
 */
function writeUrl(selected: string | null, tab: PartnerTab | null) {
  const next = partnersUrl({ selected, tab })
  if (`${window.location.pathname}${window.location.search}` !== next) window.history.replaceState(window.history.state, '', next)
}

export default function PartnersPage() {
  const searchParams = useSearchParams()
  const slugParam = searchParams.get('selected') ?? null
  const tabParam = searchParams.get('tab')
  // A tab in the URL wins; one that names no tab falls back to the first (#2137).
  const requestedTab: PartnerTab | null = tabParam === null ? null : tabFromParam(tabParam) ?? 'partner'

  const [partners, setPartners] = useState<Partner[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Partner | null>(null)
  const [creating, setCreating] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const removeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  // Synchronous re-entry guard: a state flag alone can't block a same-tick
  // double-click (no re-render between the two clicks), so the delete would
  // fire twice against a money-path config (#495).
  const deletingRef = useRef(false)
  const [formDirty, setFormDirty] = useState(false)
  /** The open partner holds a problem (a refused save's field), marked on its row beside a missing credential. */
  const [formProblem, setFormProblem] = useState(false)
  const partnerNames = useMemo(() => new Map(partners.map((p) => [p.id, p.name])), [partners])

  // Confirm before discarding unsaved partner-form edits. Used to guard the
  // in-page <button> navigations (partner switch, New) the form can't intercept.
  function confirmDiscardIfDirty(): boolean {
    return !formDirty || window.confirm(UNSAVED_CHANGES_MESSAGE)
  }

  async function load() {
    try {
      const data = await api.partners.list()
      setPartners(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load partners')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // Hydrate selection from ?selected=<slug> after the list arrives.
  useEffect(() => {
    if (!slugParam || partners.length === 0) return
    if (selected?.slug === slugParam) return
    const match = partners.find((p) => p.slug === slugParam)
    if (match) {
      setSelected(match)
      setCreating(false)
    }
  }, [slugParam, partners, selected?.slug])

  function selectPartner(p: Partner) {
    setCreating(false)
    setSelected(p)
    // A different partner opens on its own tab; the same one keeps the tab it is on.
    if (p.slug !== slugParam) writeUrl(p.slug, null)
  }

  function clearSelection() {
    setCreating(false)
    setSelected(null)
    setFormDirty(false)
    setFormProblem(false)
    if (slugParam) writeUrl(null, null)
  }

  function requestDelete(id: string) {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    setConfirmDelete(id)
    deleteTimerRef.current = setTimeout(() => setConfirmDelete(null), 4000)
  }

  async function handleDelete(id: string) {
    if (deletingRef.current) return
    deletingRef.current = true
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    setDeletingId(id)
    try {
      // Wait for the server before removing the row, so the button shows a real
      // in-flight state and a failure leaves the config in place (#495).
      const r = await api.partners.delete(id)
      // Deleted, but its stored outage copy could not be cleared yet: say so (#1846).
      if (r.stored_copy_warning) setError(r.stored_copy_warning)
      setConfirmDelete(null)
      if (selected?.id === id) clearSelection()
      setRemovingId(id)
      removeTimerRef.current = setTimeout(() => {
        setPartners((prev) => prev.filter((p) => p.id !== id))
        setRemovingId(null)
      }, 150)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete partner')
    } finally {
      deletingRef.current = false
      setDeletingId(null)
    }
  }

  async function handleSave(body: PartnerBody, id?: string, pendingUuids?: string[], request?: PartnerPageSaveRequest): Promise<PartnerSaveResult | void> {
    if (id) {
      // An edit is one save of the whole page (#2133): only the changed partner
      // fields (#2132) and the profile when it changed, at the pair of versions
      // it was edited from. The form reports a refusal itself, so it throws
      // through to it.
      if (!request) throw new Error('A partner edit needs the versions it was made from.')
      let answer: PartnerPageSaved
      try {
        answer = await api.partners.savePage(id, body, request)
      } catch (err) {
        // A press whose answer was lost but whose save landed is refused as stale
        // with its own save id: the stored halves are the saved ones (#2132, #2133).
        const e = err as { status?: number; body?: Partial<PartnerPageStale> }
        if (e.status === 409 && e.body?.last_save_id === request.save_id && e.body.partner) {
          answer = { partner: e.body.partner, profile: e.body.profile ?? null, partner_version: e.body.partner_version ?? e.body.partner.version ?? 0, profile_version: e.body.profile_version ?? 0 }
        } else throw err
      }
      const updated = answer.partner
      setPartners((prev) => prev.map((p) => p.id === id ? updated : p))
      selectPartner(updated)
      // Saved, but a stored outage copy could not be cleared yet: the form
      // shows it beside Saved, never as an error, because the save happened (#1846, #2132).
      return { partner: updated, profile: answer.profile, copyWarning: answer.stored_copy_warning ?? null }
    } else {
      const created = await api.partners.create(body as Required<PartnerBody>)
      if (pendingUuids?.length) {
        await Promise.all(pendingUuids.map((uuid) => api.partnerUuids.create({ partner_slug: created.slug, uuid })))
      }
      setPartners((prev) => [...prev, created])
      selectPartner(created)
    }
  }

  const showForm = creating || selected !== null
  const pendingSelection =
    !showForm &&
    slugParam !== null &&
    (loading || partners.some((p) => p.slug === slugParam))

  return (
    <NavLayout>
      {/* The page is the window's height, so the list stays in view while the form scrolls in its own pane (#2137). */}
      <div className="flex h-screen min-h-0">

        {/* List */}
        <div className="flex w-72 flex-shrink-0 flex-col border-r border-gray-200 bg-white">
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-4">
            <h1 className="text-3xl font-bold text-graphite">Partners</h1>
            <Button variant="primary" onClick={() => { if (!confirmDiscardIfDirty()) return; clearSelection(); setCreating(true) }} className="px-3 py-1.5 text-xs">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              New
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="space-y-1 p-3">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="rounded-lg p-3">
                    <Skeleton className="mb-1.5 h-4 w-24" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                ))}
              </div>
            ) : partners.length === 0 ? (
              <div className="p-6 text-center">
                <p className="text-base font-semibold text-graphite">No partners yet</p>
                <p className="mt-1 text-xs text-gray-500">Partners are the lenders or buyers your workflows route leads to.</p>
                <Button variant="ghost" onClick={() => { clearSelection(); setCreating(true) }} className="mt-3">
                  Add your first partner
                </Button>
              </div>
            ) : (
              <div className="p-2">
                {groupPartners(partners).map((group) => (
                  <section key={group.title} aria-labelledby={`partners-group-${group.title}`} className="mb-2">
                    <h2 id={`partners-group-${group.title}`} className="px-3 pb-1 pt-3 text-xs font-semibold text-gray-600">{group.title}</h2>
                    <div className="space-y-0.5">
                      {group.members.map((partner) => {
                        // The missing credential (#1035, #416) and a refused save's field on the open partner (PM-12).
                        const problem = partner.credential_warning ?? (selected?.id === partner.id && formProblem ? 'This partner has a problem: see its marked tab.' : null)
                        return (
                          <Button
                            key={partner.id}
                            variant="row"
                            onClick={() => { if (selected?.id !== partner.id && !confirmDiscardIfDirty()) return; setFormDirty(false); setFormProblem(false); selectPartner(partner) }}
                            className={`transition-[colors,opacity] duration-150 ${
                              selected?.id === partner.id
                                ? 'bg-gray-100'
                                : 'hover:bg-beige'
                            } ${removingId === partner.id ? 'opacity-0' : ''
                            }`}
                          >
                            {/*
                              Name only (the settled design). Not a nested control: the
                              whole row is one button, so the problem mark is text to a
                              screen reader (its sr-only sentence) and a title on hover.
                            */}
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-sm font-medium text-graphite">{partner.name}</span>
                              {problem && <span title={problem} className="inline-flex"><ProblemMark label={problem} /></span>}
                            </span>
                          </Button>
                        )
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Detail / form */}
        <div className="flex-1 overflow-y-auto p-8" data-form-pane="">
          {error && (
            <div className="mb-6 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              {error}
            </div>
          )}

          {showForm ? (
            <PartnerForm
              key={selected?.id ?? 'new'}
              partner={selected ?? undefined}
              onSave={handleSave}
              onCancel={clearSelection}
              onDelete={selected ? (id) => requestDelete(id) : undefined}
              confirmingDelete={confirmDelete === selected?.id}
              onConfirmDelete={selected ? () => handleDelete(selected.id) : undefined}
              onCancelDelete={() => { if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current); setConfirmDelete(null) }}
              deleting={deletingId === selected?.id}
              onDirtyChange={setFormDirty}
              requestedTab={selected ? requestedTab : null}
              onTabChange={(tab) => { if (selected) writeUrl(selected.slug, tab) }}
              partnerNames={partnerNames}
              onProblemChange={setFormProblem}
            />
          ) : pendingSelection ? (
            <div className="max-w-3xl space-y-6">
              <div className="space-y-2">
                <Skeleton className="h-7 w-48" />
                <Skeleton className="h-4 w-72" />
              </div>
              <div className="space-y-4">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="space-y-2">
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="h-9 w-full" />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <div className="mb-3 flex justify-center gap-2">
                  <CircleCheck className="h-5 w-5 text-green-400" />
                  <CircleOff className="h-5 w-5 text-gray-300" />
                </div>
                <p className="text-sm font-medium text-gray-700">Select a partner to configure</p>
                <p className="mt-1 text-xs text-gray-600">Or create a new one with the button above.</p>
              </div>
            </div>
          )}
        </div>

      </div>
    </NavLayout>
  )
}
