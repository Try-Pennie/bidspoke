'use client'

export const runtime = 'edge'

import { Suspense, useCallback, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import NavLayout from '@/components/NavLayout'
import { api } from '@/lib/api'
import { GoogleSignInReturn, signInReturnOf } from '@/components/connections/GoogleSignInReturn'

/**
 * The page Google sends the browser back to after Sign in with Google (#2338,
 * build PR 13; R17): the redirect URI the sign in app names,
 * https://bidspoke.trypennie.dev/connections/google/callback. Who sees it: any
 * signed in user, as every page here; the finish route claims the state only
 * for the user and organization that started it.
 */
function Return() {
  const router = useRouter()
  const params = useSearchParams()
  const ret = useMemo(() => signInReturnOf(params), [params])
  const finish = useCallback((body: Parameters<typeof api.connections.finishGoogleSignIn>[0]) => api.connections.finishGoogleSignIn(body), [])
  // The saved connection, chosen and open (R18). This page holds nothing editable, so leaving loses nothing.
  const open = useCallback((id: string) => router.replace(`/connections?connection=${encodeURIComponent(id)}`), [router])
  return <GoogleSignInReturn ret={ret} finish={finish} open={open} />
}

export default function GoogleSignInCallbackPage() {
  return (
    <NavLayout>
      <Suspense fallback={null}>
        <Return />
      </Suspense>
    </NavLayout>
  )
}
