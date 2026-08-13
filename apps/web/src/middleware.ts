import { createServerClient } from '@supabase/ssr'
import { type NextRequest, NextResponse } from 'next/server'
import { classifyAllowlistRpc, decideGate, GATE_HEADER, type AllowlistLookup } from './lib/auth-gate'
import { isPermittedDomain } from './lib/auth-allowlist'
import { isPublicPath } from './lib/public-paths'

/**
 * The login gate. The DECISION is a pure function in lib/auth-gate.ts with a
 * unit test per branch; this file only gathers the inputs and applies the
 * result (#728).
 *
 * Every response carries `x-bidspoke-gate` naming which branch acted, including
 * the allow path. Without a positive signal on allow there is no way to tell
 * "the middleware ran and allowed this" from "the middleware never ran", and
 * that indistinguishability is the failure this exists to make visible.
 */
export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Refresh session (required for SSR auth)
  const { data: { user } } = await supabase.auth.getUser()
  const email = user?.email ?? null

  const { pathname } = request.nextUrl

  // Only read the allowlist when the decision can actually depend on it: a
  // protected path, a signed-in user, and a permitted domain. The read is the
  // one part that can fail, and its failure is now a state of its own rather
  // than a dropped error that looked like a denial.
  let allowlist: AllowlistLookup = { status: 'absent' }
  if (email !== null && !isPublicPath(pathname) && isPermittedDomain(email)) {
    // Asks `is_allowlisted()` rather than reading the table (#729). The address
    // is not passed in: the function takes it from the caller's own verified
    // JWT, so this cannot be used to ask about anybody else.
    allowlist = await lookupAllowlist(() => supabase.rpc('is_allowlisted'))
  }

  const decision = decideGate({ pathname, email, allowlist })

  if (decision.action === 'redirect') {
    const url = request.nextUrl.clone()
    url.pathname = decision.pathname
    url.search = decision.search ?? ''
    const redirect = NextResponse.redirect(url)
    redirect.headers.set(GATE_HEADER, decision.gate)
    return redirect
  }

  supabaseResponse.headers.set(GATE_HEADER, decision.gate)
  return supabaseResponse
}

/**
 * Runs the allowlist lookup and classifies its outcome. Takes the call as a
 * thunk rather than the client, so this stays a plain three-state classifier and
 * does not have to name Supabase's generic query types.
 *
 * The classification itself lives in auth-gate.ts next to the decision it feeds,
 * where it is unit tested per branch. All this adds is the thrown-error case: a
 * network failure never reaches the classifier at all.
 */
async function lookupAllowlist(
  call: () => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<AllowlistLookup> {
  try {
    return classifyAllowlistRpc(await call())
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : 'allowlist lookup threw' }
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
