import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from '@/lib/api'

/**
 * The live partner list for the canvas, fetched once per canvas and shared by
 * every card (#645).
 *
 * Partner Bid cards used to print `config.partner_name`, a copy of the name
 * taken when the partner was picked. The engine resolves the partner by id
 * against the live table and never reads that copy, so a rename left the card
 * asserting a name that was no longer true. Cards resolve by id through this
 * context instead, so what they show follows the same source of truth the engine
 * uses.
 *
 * Best-effort, exactly like TimeoutSuggestionsProvider: on fetch failure `loaded`
 * stays false and cards show a neutral placeholder rather than accusing a node of
 * pointing at a missing partner.
 */
export interface CanvasPartners {
  byId: Map<string, { name: string }>
  loaded: boolean
}

const PartnersContext = createContext<CanvasPartners>({ byId: new Map(), loaded: false })

export function useCanvasPartners(): CanvasPartners {
  return useContext(PartnersContext)
}

export function PartnersProvider({ children }: { children: ReactNode }) {
  const [partners, setPartners] = useState<CanvasPartners>({ byId: new Map(), loaded: false })

  useEffect(() => {
    let cancelled = false
    api.partners
      .list()
      .then((list) => {
        if (cancelled) return
        setPartners({ byId: new Map(list.map((p) => [p.id, { name: p.name }])), loaded: true })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  return <PartnersContext.Provider value={partners}>{children}</PartnersContext.Provider>
}
