'use client'

export const runtime = 'edge'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import NavLayout from '@/components/NavLayout'
import { api } from '@/lib/api'
import { ConnectionsScreen, type ConnectionsSource } from '@/components/connections/ConnectionsScreen'

/**
 * The Connections page (#2338, build PRs 9 and 10). Who sees it and who may
 * change it: any signed in user of the organization, as every route it calls,
 * the save, Reconnect and Remove included, answers only for the caller's own
 * organization (routes/api/connections.ts).
 */
const live: ConnectionsSource = {
  list: () => api.connections.list(),
  history: (id) => api.connections.history(id),
  googleSubjects: () => api.connections.googleSubjects(),
  addGoogleSubject: (body) => api.connections.addGoogleSubject(body),
  removeGoogleSubject: (kind, subject) => api.connections.removeGoogleSubject(kind, subject),
  create: (body) => api.connections.create(body),
  reconnect: (id, body) => api.connections.reconnect(id, body),
  remove: (id) => api.connections.remove(id),
}

/**
 * ?connection=<id> opens that connection: a step's problem line links here to
 * where it is fixed (build PR 11, R8). An id the list does not hold opens the
 * first connection, as a page with none named does.
 */
function Screen() {
  const named = useSearchParams()?.get('connection')
  return <ConnectionsScreen source={live} initialChosen={named ? { kind: 'connection', id: named } : undefined} />
}

export default function ConnectionsPage() {
  return (
    <NavLayout>
      <Suspense fallback={null}>
        <Screen />
      </Suspense>
    </NavLayout>
  )
}
