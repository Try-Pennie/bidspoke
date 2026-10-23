'use client'

export const runtime = 'edge'

import { Suspense, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { signInReturnHref } from '@/components/connections/google-sign-in-return'

/**
 * Where Google sends the browser back after Sign in with Google (#2338, build
 * PR 13): the redirect URI the sign in app names,
 * https://bidspoke.trypennie.dev/connections/google/callback. Dan's decision
 * D1 of 2026-10-23: no page of its own. It hands what Google put on its
 * address to the Connections page, which finishes the sign in in the form or
 * Reconnect dialog the person left. It draws nothing, holds nothing and asks
 * the Worker nothing.
 */
function Return() {
  const router = useRouter()
  const params = useSearchParams()
  useEffect(() => {
    router.replace(signInReturnHref(params))
  }, [router, params])
  return null
}

export default function GoogleSignInCallbackPage() {
  return (
    <Suspense fallback={null}>
      <Return />
    </Suspense>
  )
}
