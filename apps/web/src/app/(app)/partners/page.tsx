'use client'

export const runtime = 'edge'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import type { Partner, PartnerBody, PartnerDeleted, PartnerPageSaveRequest, PartnerPageSaved, PartnerPageStale } from '@/lib/api'
import { BIDDING_PICKUP } from '@/lib/bidding-pickup'
import NavLayout from '@/components/NavLayout'
import { Plus, CircleCheck, CircleOff, AlertTriangle } from 'lucide-react'
import { Skeleton } from '@/components/ui/Skeleton'
import { Button, FieldError } from '@/components/ui/form'
import { ProblemMark } from '@/components/ui/ProblemMark'
import PartnerForm, { type PartnerSaveResult } from './PartnerForm'
import { leaveThen } from '@/lib/leave-guard'
import { PartnerLiveProvider } from '@/components/partners/live/PartnerLive'
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
  const [removingId, setRemovingId] = useState<string | null>(null)
  const removeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // What a committed delete left to say (#2140): never an error, because the
  // delete happened. The delete box itself guards against a double press.
  const [deletedNotice, setDeletedNotice] = useState<string[] | null>(null)
  /** The open partner holds a problem (a refused save's field), marked on its row beside a missing credential. */
  const [formProblem, setFormProblem] = useState(false)
  const partnerNames = useMemo(() => new Map(partners.map((p) => [p.id, p.name])), [partners])
  /** The foot of the form pane, where the form draws its save bar (#2138). */
  const [barSlot, setBarSlot] = useState<HTMLDivElement | null>(null)

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
    // A different partner opens on its own tab; the same one keeps the tab it is on.
    if (p.slug !== slugParam) writeUrl(p.slug, null)
  }

  function clearSelection() {
    setCreating(false)
    setSelected(null)
    setFormProblem(false)
    if (slugParam) writeUrl(null, null)
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
    // The live channel (#2135) is the page's, so switching partners keeps one Supabase client.
    <PartnerLiveProvider>
    <NavLayout>
      {/* The page is the window's height, so the list stays in view while the form scrolls in its own pane (#2137). */}
      <div className="flex h-screen min-h-0">

        {/* List */}
        <div className="flex w-72 flex-shrink-0 flex-col border-r border-gray-200 bg-white">
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-4">
            <h1 className="text-3xl font-bold text-graphite">Partners</h1>
            {/* Leaving a partner with something unsaved asks first, in the form's own dialog (#2138, PM-5). */}
            <Button variant="primary" onClick={() => leaveThen({ kind: 'page', name: 'a new partner' }, () => { clearSelection(); setCreating(true) })} className="px-3 py-1.5 text-xs">
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
                <p className="mt-1 text-xs text-hint">Partners are the lenders or buyers your workflows route leads to.</p>
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
                        const problem = partner.credential_warning ?? (selected?.id === partner.id && formProblem ? 'This partner has a problem: see the form.' : null)
                        return (
                          <Button
                            key={partner.id}
                            variant="row"
                            onClick={() => {
                              if (selected?.id === partner.id) return selectPartner(partner)
                              leaveThen({ kind: 'partner', name: partner.name }, () => { setFormProblem(false); selectPartner(partner) })
                            }}
                            className={`transition-[colors,opacity] duration-150 ${
                              selected?.id === partner.id
                                ? 'bg-beige-deep'
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

        {/* Detail / form, with the save bar across its foot under the scrolling form (#2138). */}
        <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto p-8" data-form-pane="">
          {error && (
            <FieldError as="div" boxed size="sm" className="mb-6 flex items-center gap-2 px-4 py-3">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              {error}
            </FieldError>
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
              barSlot={barSlot}
              onSaveConfirmed={(saved) => { setPartners((prev) => prev.map((p) => (p.id === saved.id ? saved : p))); setSelected(saved) }}
              requestedTab={selected ? requestedTab : null}
              onTabChange={(tab) => { if (selected) writeUrl(selected.slug, tab) }}
              partnerNames={partnerNames}
              onProblemChange={setFormProblem}
              onLiveUpdate={(p) => setPartners((prev) => prev.map((x) => (x.id === p.id ? p : x)))}
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
        <div ref={setBarSlot} />
        </div>

      </div>
    </NavLayout>
    </PartnerLiveProvider>
  )
}
