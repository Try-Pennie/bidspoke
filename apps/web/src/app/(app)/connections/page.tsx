'use client'

export const runtime = 'edge'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import NavLayout from '@/components/NavLayout'
import { api } from '@/lib/api'
import { leaveThen } from '@/lib/leave-guard'
import { sessionKeptSignIns } from '@/components/connections/google-sign-in-kept'
import { connectionsSignInReturn } from '@/components/connections/google-sign-in-return'
import { ConnectionsScreen, type ConnectionsSource } from '@/components/connections/ConnectionsScreen'

/**
 * The Connections page (#2338, build PRs 9, 10 and 14). Who sees it and who
 * may change it: any signed in user of the organization, as every route it
 * calls, the save, Reconnect and Remove included, answers only for the
 * caller's own organization (routes/api/connections.ts), and so do the Slack
 * alerts login's alert settings (routes/api/integrations.ts).
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
  replace: (id, body) => api.connections.replace(id, body),
  startGoogleSignIn: (body) => api.connections.startGoogleSignIn(body),
  finishGoogleSignIn: (body) => api.connections.finishGoogleSignIn(body),
  // The add form's values across the round trip to Google, in this tab's session storage (D1).
  keptSignIns: sessionKeptSignIns(),
  // Google's page, once nothing on this one would be lost (the screen waits for that); asked through the guard all the same.
  goTo: (url) => leaveThen({ kind: 'page', name: 'Google' }, () => window.location.assign(url)),
  slackAlerts: () => api.integrations.getSlack(),
  updateSlackAlerts: (patch) => api.integrations.updateSlackSettings(patch),
  searchSlackChannels: (q) => api.integrations.searchSlackChannels(q),
}

/**
 * ?connection=<id> opens that connection: a step's problem line links here to
 * where it is fixed (build PR 11, R8). An id the list does not hold opens the
 * first connection, as a page with none named does. ?connection=slack-alerts
 * (SLACK_ALERT_LOGIN_LINK) opens the Slack alerts login, which is where
 * /integrations now sends a reader (build PR 14).
 */
function Screen() {
  const params = useSearchParams()
  const named = params?.get('connection')
  // Back from Sign in with Google (D1, Dan 2026-10-23): read once, finished in the form it left.
  const [signInReturn] = useState(() => connectionsSignInReturn(params))
  // Google's code and state leave the address bar at once, so a refresh or Back never posts them again.
  useEffect(() => {
    if (signInReturn) window.history.replaceState(window.history.state, '', '/connections')
  }, [signInReturn])
  return <ConnectionsScreen source={live} initialChosen={named ? { kind: 'connection', id: named } : undefined} signInReturn={signInReturn} />
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
