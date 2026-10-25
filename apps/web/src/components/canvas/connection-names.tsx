'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, type ConnectionList } from '@/lib/api'

/**
 * Where the canvas reads its organization's connections from, to name a step's
 * connection (#2339: the tick box before a test that sends for real names the
 * connection it sends from). GET /api/connections in the app; the development
 * preview gives its fixture's list instead (app/dev/app-action).
 */
const ConnectionListSource = createContext<() => Promise<ConnectionList>>(() => api.connections.list())

export function ConnectionListProvider({ load, children }: { load: () => Promise<ConnectionList>; children: ReactNode }) {
  return <ConnectionListSource.Provider value={load}>{children}</ConnectionListSource.Provider>
}

/**
 * The name of the connection with this id, or null: none chosen, the list not
 * read yet, refused, or holding no such connection. A caller words the null
 * case itself ("this step's connection"), never as another connection's name.
 */
export function useConnectionName(connectionId: string | null): string | null {
  const load = useContext(ConnectionListSource)
  const [name, setName] = useState<{ id: string; name: string | null } | null>(null)
  useEffect(() => {
    if (connectionId === null) return
    let live = true
    load().then(
      (list) => { if (live) setName({ id: connectionId, name: list.connections.find((c) => c.id === connectionId)?.name ?? null }) },
      () => { if (live) setName({ id: connectionId, name: null }) },
    )
    return () => { live = false }
  }, [connectionId, load])
  return connectionId !== null && name?.id === connectionId ? name.name : null
}
