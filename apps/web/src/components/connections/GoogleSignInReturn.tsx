'use client'

/**
 * Where Google sends the browser back after Sign in with Google (#2338, build
 * PR 13; R17): the Connections page's callback. It posts what Google put on
 * its address (the state with a code, or Google's error) to the Worker with
 * the person's own session, which claims the state once, for that person, and
 * saves the connection.
 *
 * It shows the finish working with its seconds counting, then either takes
 * the person to the saved connection on the Connections page, chosen and open
 * with no message (R18), or says why nothing was saved, in the route's own
 * sentence, with the way back. Nothing here is editable, so leaving loses
 * nothing.
 */
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { FieldError, Outcome } from '@/components/ui/form'
import { saveFailureSentence } from './add-form-model'

/** What the callback's address holds, read once. */
export type SignInReturn = { kind: 'finish'; body: { state: string; code: string } | { state: string; error: string } } | { kind: 'empty' }

/** The body the finish posts, from the callback's search parameters, or empty when Google sent neither. */
export function signInReturnOf(params: { get(name: string): string | null } | null): SignInReturn {
  const state = params?.get('state') ?? ''
  const code = params?.get('code') ?? ''
  const error = params?.get('error') ?? ''
  if (state === '') return { kind: 'empty' }
  if (code !== '') return { kind: 'finish', body: { state, code } }
  if (error !== '') return { kind: 'finish', body: { state, error } }
  return { kind: 'empty' }
}

/** When the address holds no sign in at all: opened by hand, or Google sent nothing. */
export const NO_SIGN_IN = 'This page holds no sign in to finish. Nothing was saved. Start it again from the Connections page.'

/** How long the finish may take before its line says it stalled: the client's own ceiling (api.ts). */
const FINISH_DEADLINE_MS = 120_000

export function GoogleSignInReturn({ ret, finish, open, now = () => Date.now() }: {
  ret: SignInReturn
  finish: (body: { state: string; code: string } | { state: string; error: string }) => Promise<{ connection: { id: string } }>
  /** Opens the saved connection on the Connections page. */
  open: (connectionId: string) => void
  now?: () => number
}) {
  const [startedAt] = useState(now)
  const [tick, setTick] = useState(startedAt)
  const [failed, setFailed] = useState<string | null>(ret.kind === 'empty' ? NO_SIGN_IN : null)
  // Once: a second post of one state is refused as used, and would show that over the first's answer.
  const sent = useRef(false)

  useEffect(() => {
    if (ret.kind !== 'finish' || sent.current) return
    sent.current = true
    finish(ret.body).then(
      (a) => open(a.connection.id),
      (err: unknown) => setFailed(saveFailureSentence(err, 'Google', FINISH_DEADLINE_MS, 'saved')),
    )
  }, [ret, finish, open])

  useEffect(() => {
    if (failed !== null) return
    const id = setInterval(() => setTick(now()), 1000)
    return () => clearInterval(id)
  }, [failed, now])

  return (
    <section className="cx-card cx-detail" data-part="google-sign-in-return" aria-label="Sign in with Google">
      <h2>Sign in with Google</h2>
      {failed === null
        ? <Outcome state={{ kind: 'working', label: 'Finishing the sign in with Google', startedAt, now: tick }} />
        : (
          <>
            <FieldError alert size="sm" part="save-line" partState="failed">{failed}</FieldError>
            <p><Link href="/connections" className="cx-link">Back to Connections</Link></p>
          </>
        )}
    </section>
  )
}
