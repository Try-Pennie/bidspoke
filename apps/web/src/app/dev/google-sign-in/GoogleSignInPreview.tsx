'use client'

import { GoogleSignInReturn } from '@/components/connections/GoogleSignInReturn'

const DENIED = Object.assign(new Error('google_sign_in_denied'), {
  status: 422,
  body: { error: 'google_sign_in_denied', message: 'You did not allow Bidspoke into your Google account. Nothing was saved. Sign in with Google again and allow it to connect.' },
})

/** The callback page in one of its three states, with a finish that never reaches the Worker. */
export function GoogleSignInPreview({ frame }: { frame: 'working' | 'failed' | 'empty' }) {
  return (
    <main style={{ padding: 24, maxWidth: 720 }}>
      <GoogleSignInReturn
        ret={frame === 'empty' ? { kind: 'empty' } : { kind: 'finish', body: { state: 'preview', code: 'preview' } }}
        finish={() => (frame === 'failed' ? Promise.reject(DENIED) : new Promise(() => {}))}
        open={() => undefined}
      />
    </main>
  )
}
