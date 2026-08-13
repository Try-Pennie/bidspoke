'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

/**
 * This page is prerendered at build time, and reading the query string forces a
 * client bailout that Next requires a Suspense boundary for: without one the
 * production build fails outright on this route.
 *
 * The fallback must not be either verdict. Showing "Access denied" while the
 * reason is still unknown would tell someone whose access check merely failed
 * that they were refused, which is the exact confusion this page was split to
 * remove, so the fallback states no outcome at all.
 */
export default function AccessDeniedPage() {
  return (
    <Suspense fallback={<PendingCard />}>
      <AccessDeniedContent />
    </Suspense>
  )
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-beige">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        {children}
      </div>
    </div>
  )
}

function PendingCard() {
  return (
    <CardShell>
      <h1 className="text-2xl font-semibold text-graphite">Checking your access</h1>
      <p className="text-sm text-gray-600">One moment.</p>
    </CardShell>
  )
}

/**
 * Two different things land here, and they must not read the same (#728).
 *
 * A genuine refusal (wrong domain, or a company address that is not on the
 * allowlist) is a decision about the account, so it says so and signs the
 * session out to avoid a redirect loop back into a protected route.
 *
 * A `reason=gate_unavailable` arrival means the gate could not READ the
 * allowlist, so it does not know whether this person is allowed. It fails closed
 * because that is the safe side, but it must not claim the account lacks
 * permission, and it must not sign a legitimate employee out over a failed
 * database read: the fix is to try again, and signing out only adds a login to
 * the recovery.
 */
function AccessDeniedContent() {
  const searchParams = useSearchParams()
  const gateUnavailable = searchParams.get('reason') === 'gate_unavailable'
  const [signedOut, setSignedOut] = useState(false)

  useEffect(() => {
    if (gateUnavailable) return
    createClient()
      .auth.signOut()
      .finally(() => setSignedOut(true))
  }, [gateUnavailable])

  if (gateUnavailable) {
    return (
      <CardShell>
        <h1 className="text-2xl font-semibold text-graphite">Can&apos;t check your access right now</h1>
        <p className="text-sm text-gray-600">
          We couldn&apos;t reach the list of permitted accounts, so we can&apos;t confirm yours. You are
          still signed in.
        </p>
        <p className="text-sm text-gray-600">
          Try again in a moment. If it keeps happening, tell the systems team that the access check is
          failing, not that you were denied.
        </p>
        <a
          href="/workflows"
          className="block w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-center text-sm font-medium text-gray-700 shadow-sm hover:bg-beige"
        >
          Try again
        </a>
      </CardShell>
    )
  }

  return (
    <CardShell>
      <h1 className="text-2xl font-semibold text-graphite">Access denied</h1>
      <p className="text-sm text-gray-600">
        Your account doesn&apos;t have permission to access Bidspoke.
      </p>
      <p className="text-sm text-gray-600">
        Contact the systems team if you believe you should have access.
      </p>
      {signedOut && (
        <a
          href="/login"
          className="block w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-center text-sm font-medium text-gray-700 shadow-sm hover:bg-beige"
        >
          Back to sign in
        </a>
      )}
    </CardShell>
  )
}
