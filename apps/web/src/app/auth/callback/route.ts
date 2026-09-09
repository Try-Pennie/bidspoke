export const runtime = 'edge'

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { isPermittedDomain } from '@/lib/auth-allowlist'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')

  // Where sign-in lands is fixed here and is never taken from the request (#730).
  //
  // This used to accept a `next` parameter and redirect to `origin + next`.
  // `origin` carries no trailing slash, which is the whole bug: `@evil.com`
  // makes `https://bidspoke.trypennie.dev@evil.com`, where everything before the
  // `@` is userinfo and the browser goes to evil.com, and `.evil.com` makes a
  // hostname an attacker can simply own. Either one lands the user on an
  // attacker's page at the exact moment they have just proved they trust us.
  //
  // Deleted rather than validated, because nothing in the app ever sent it, so it
  // was attacker-only surface. A list of forbidden prefixes is always one shape
  // short of the next report; having no caller-supplied value at all is not.
  //
  // The destination is written inline at the redirect rather than held in a
  // variable, so the guard on this file can assert every redirect target is a
  // literal path. A named variable would read the same and would let a
  // caller-supplied value back in under a different name.

  if (code) {
    // Next 15 made cookies() async. Awaited once here so both closures below
    // see the resolved store rather than the promise.
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          },
        },
      }
    )
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      // Fast domain reject — non-@trypennie.com accounts are blocked immediately.
      // Per-email allowlist enforcement is handled by the middleware DB check on
      // the first protected page load after this redirect.
      const { data: { user } } = await supabase.auth.getUser()
      if (!isPermittedDomain(user?.email)) {
        return NextResponse.redirect(`${origin}/access-denied`)
      }
      return NextResponse.redirect(`${origin}/workflows`)
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
}
