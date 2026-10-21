'use client'

export const runtime = 'edge'

import NavLayout from '@/components/NavLayout'
import { api } from '@/lib/api'
import { ConnectionsScreen, type ConnectionsSource } from '@/components/connections/ConnectionsScreen'

/**
 * The Connections page (#2338, build PR 9). Who sees it: any signed in user of
 * the organization, as every route it calls answers only for the caller's own
 * organization (routes/api/connections.ts).
 */
const live: ConnectionsSource = {
  list: () => api.connections.list(),
  history: (id) => api.connections.history(id),
  googleSubjects: () => api.connections.googleSubjects(),
  addGoogleSubject: (body) => api.connections.addGoogleSubject(body),
  removeGoogleSubject: (kind, subject) => api.connections.removeGoogleSubject(kind, subject),
}

export default function ConnectionsPage() {
  return (
    <NavLayout>
      <ConnectionsScreen source={live} />
    </NavLayout>
  )
}
