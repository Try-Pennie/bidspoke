'use client'

export const runtime = 'edge'

import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { Partner, PartnerBody } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import { Plus, ChevronRight, CircleCheck, CircleOff, AlertTriangle } from 'lucide-react'
import { Skeleton } from '@/components/ui/Skeleton'
import PartnerForm from './PartnerForm'

export default function PartnersPage() {
  const [partners, setPartners] = useState<Partner[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Partner | null>(null)
  const [creating, setCreating] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const removeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  function requestDelete(id: string) {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    setConfirmDelete(id)
    deleteTimerRef.current = setTimeout(() => setConfirmDelete(null), 4000)
  }

  async function handleDelete(id: string) {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    setConfirmDelete(null)
    const item = partners.find((p) => p.id === id)
    if (selected?.id === id) setSelected(null)
    setRemovingId(id)
    removeTimerRef.current = setTimeout(() => {
      setPartners((prev) => prev.filter((p) => p.id !== id))
      setRemovingId(null)
    }, 150)
    try {
      await api.partners.delete(id)
    } catch (e) {
      if (removeTimerRef.current) clearTimeout(removeTimerRef.current)
      setRemovingId(null)
      if (item) setPartners((prev) => prev.find((p) => p.id === id) ? prev : [...prev, item])
      setError(e instanceof Error ? e.message : 'Failed to delete partner')
    }
  }

  async function handleSave(body: PartnerBody, id?: string, pendingUuids?: string[]) {
    if (id) {
      const updated = await api.partners.update(id, body)
      setPartners((prev) => prev.map((p) => p.id === id ? updated : p))
      setSelected(updated)
    } else {
      const created = await api.partners.create(body as Required<PartnerBody>)
      if (pendingUuids?.length) {
        await Promise.all(pendingUuids.map((uuid) => api.partnerUuids.create({ partner_slug: created.slug, uuid })))
      }
      setPartners((prev) => [...prev, created])
      setCreating(false)
      setSelected(created)
    }
  }

  const showForm = creating || selected !== null

  return (
    <NavLayout>
      <div className="flex min-h-0 flex-1">

        {/* List */}
        <div className="flex w-72 flex-shrink-0 flex-col border-r border-gray-200 bg-white">
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-4">
            <h1 className="text-3xl font-bold text-graphite">Partners</h1>
            <button
              onClick={() => { setSelected(null); setCreating(true) }}
              className="flex items-center gap-1.5 rounded-lg bg-p-blue-dark px-3 py-1.5 text-xs font-medium text-white hover:bg-[#3A8FD0]"
            >
              <Plus className="h-3.5 w-3.5" />
              New
            </button>
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
                <p className="mt-1 text-xs text-gray-400">Partners are the lenders or buyers your workflows route leads to.</p>
                <button
                  onClick={() => { setSelected(null); setCreating(true) }}
                  className="mt-3 text-xs font-medium text-p-blue-dark hover:text-p-blue-dark"
                >
                  Add your first partner →
                </button>
              </div>
            ) : (
              <div className="space-y-0.5 p-2">
                {partners.map((partner) => (
                  <button
                    key={partner.id}
                    onClick={() => { setCreating(false); setSelected(partner) }}
                    className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-[colors,opacity] duration-150 ${
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
                      </div>
                      <p className="mt-0.5 truncate font-mono text-xs text-gray-400">{partner.slug}</p>
                    </div>
                    <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-gray-300 group-hover:text-gray-400" />
                  </button>
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

          {showForm ? (
            <PartnerForm
              key={selected?.id ?? 'new'}
              partner={selected ?? undefined}
              onSave={handleSave}
              onCancel={() => { setCreating(false); setSelected(null) }}
              onDelete={selected ? (id) => requestDelete(id) : undefined}
              confirmingDelete={confirmDelete === selected?.id}
              onConfirmDelete={selected ? () => handleDelete(selected.id) : undefined}
              onCancelDelete={() => { if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current); setConfirmDelete(null) }}
              deleting={false}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <div className="mb-3 flex justify-center gap-2">
                  <CircleCheck className="h-5 w-5 text-green-400" />
                  <CircleOff className="h-5 w-5 text-gray-300" />
                </div>
                <p className="text-sm font-medium text-gray-700">Select a partner to configure</p>
                <p className="mt-1 text-xs text-gray-400">Or create a new one with the button above.</p>
              </div>
            </div>
          )}
        </div>

      </div>
    </NavLayout>
  )
}
