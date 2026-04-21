'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function AccessDeniedPage() {
  const [done, setDone] = useState(false)

  useEffect(() => {
    // Sign out the session so they aren't stuck in an infinite redirect loop
    // if they navigate back to a protected route.
    createClient()
      .auth.signOut()
      .finally(() => setDone(true))
  }, [])

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-graphite">Access denied</h1>
        <p className="text-sm text-gray-500">
          Your account doesn&apos;t have permission to access Bidspoke.
        </p>
        <p className="text-sm text-gray-500">
          Contact the systems team if you believe you should have access.
        </p>
        {done && (
          <a
            href="/login"
            className="block w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-center text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
          >
            Back to sign in
          </a>
        )}
      </div>
    </div>
  )
}
