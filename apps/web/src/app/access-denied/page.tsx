'use client'

import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'

export default function AccessDeniedPage() {
  // Sign out any lingering session so the user isn't stuck in a loop
  useEffect(() => {
    createClient().auth.signOut().catch(() => {})
  }, [])

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm space-y-6 rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Access denied</h1>
          <p className="mt-2 text-sm text-gray-500">
            Your account doesn&apos;t have permission to access Bidspoke.
          </p>
          <p className="mt-3 text-sm text-gray-500">
            Contact the systems team if you believe you should have access.
          </p>
        </div>
        <Link
          href="/login"
          className="block w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-center text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
        >
          Back to sign in
        </Link>
      </div>
    </div>
  )
}
