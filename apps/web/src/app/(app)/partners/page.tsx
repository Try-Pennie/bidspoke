'use client'

export const runtime = 'edge'

import { useEffect, useRef, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import type { Partner, PartnerBody, PartnerDeleted, PartnerPageSaveRequest, PartnerPageSaved, PartnerPageStale } from '@/lib/api'
import { BIDDING_PICKUP } from '@/lib/bidding-pickup'
import NavLayout from '@/components/NavLayout'
import { Plus, ChevronRight, CircleCheck, CircleOff, AlertTriangle } from 'lucide-react'
import { Skeleton } from '@/components/ui/Skeleton'
import { Button } from '@/components/ui/form'
import PartnerForm, { UNSAVED_CHANGES_MESSAGE, type PartnerSaveResult } from './PartnerForm'

export default function PartnersPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const slugParam = searchParams.get('selected') ?? null

  const [partners, setPartners] = useState<Partner[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Partner | null>(null)
  const [creating, setCreating] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const removeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // What a committed delete left to say (#2140): never an error, because the
  // delete happened. The delete box itself guards against a double press.
  const [deletedNotice, setDeletedNotice] = useState<string[] | null>(null)
  const [formDirty, setFormDirty] = useState(false)

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
    setDeletedNotice(null)
    setCreating(false)
    setSelected(p)
    if (p.slug !== slugParam) {
      router.replace(`/partners?selected=${encodeURIComponent(p.slug)}`, { scroll: false })
    }
  }

  function clearSelection() {
    setCreating(false)
    setSelected(null)
    setFormDirty(false)
    if (slugParam) router.replace('/partners', { scroll: false })
  }

  /**
   * The delete box committed a delete (#2140). The row fades out, and what the
   * answer says is shown as a standing notice, not an error: a stored copy not
   * yet cleared (with when bidding stops using it), or state kept under the
   * slug that could not be reset.
   */
  function handleDeleted(id: string, answer: PartnerDeleted) {
    const name = partners.find((p) => p.id === id)?.name ?? 'The partner'
    const lines = [`${name} was deleted.`]
    if (answer.stored_copy_warning) {
      lines.push(answer.stored_copy_warning, `Bidding stops using ${name} within about ${BIDDING_PICKUP.partnerConstantsMinutes} minutes while the database is reachable.`)
    }
    if (answer.state_reset_warning) lines.push(answer.state_reset_warning)
    setDeletedNotice(lines)
    if (selected?.id === id) clearSelection()
    setRemovingId(id)
    removeTimerRef.current = setTimeout(() => {
      setPartners((prev) => prev.filter((p) => p.id !== id))
      setRemovingId(null)
    }, 150)
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
      <div className="flex min-h-0 flex-1">

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
              <div className="space-y-0.5 p-2">
                {partners.map((partner) => (
                  <Button
                    key={partner.id}
                    variant="row"
                    onClick={() => { if (selected?.id !== partner.id && !confirmDiscardIfDirty()) return; setFormDirty(false); selectPartner(partner) }}
                    className={`group gap-3 transition-[colors,opacity] duration-150 ${
                      selected?.id === partner.id
                        ? 'bg-gray-100'
                        : 'hover:bg-beige'
                    } ${removingId === partner.id ? 'opacity-0' : ''
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-graphite">{partner.name}</span>
                        {!partner.is_active && (
                          <span className="flex-shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                            inactive
                          </span>
                        )}
                        {/*
                          #1035. The save-time credential check (#416) rendered only
                          inside this partner's own form, so it reached only someone
                          who had already opened it. Here it is on the row a person
                          scanning the list passes.

                          Not a nested control: the whole row is one button, so an
                          interactive marker would be invalid markup and would steal
                          the click that opens the partner. The icon carries the full
                          message as text (sr-only) so a screen reader gets the
                          reason, and as a title so a pointer does on hover.
                        */}
                        {partner.credential_warning && (
                          <span className="flex-shrink-0 text-amber-700" title={partner.credential_warning}>
                            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                            <span className="sr-only">{partner.credential_warning}</span>
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate font-mono text-xs text-gray-500">{partner.slug}</p>
                    </div>
                    <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-gray-300 group-hover:text-gray-500" />
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Detail / form */}
        <div className="flex-1 overflow-y-auto p-8">
          {error && (
            <div className="mb-6 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              {error}
            </div>
          )}

          {deletedNotice && (
            <div role="status" className={`mb-6 space-y-1 rounded-lg border px-4 py-3 text-sm ${deletedNotice.length > 1 ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-gray-200 bg-white text-gray-700'}`}>
              {deletedNotice.map((line) => <p key={line}>{line}</p>)}
            </div>
          )}

          {showForm ? (
            <PartnerForm
              key={selected?.id ?? 'new'}
              partner={selected ?? undefined}
              onSave={handleSave}
              onCancel={clearSelection}
              onDeleted={handleDeleted}
              onDirtyChange={setFormDirty}
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
