import { createServerClient } from '@supabase/ssr'
import { type NextRequest, NextResponse } from 'next/server'

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

  // Refresh session — required for SSR auth
  const { data: { user } } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl
  const isPublicPath =
    pathname.startsWith('/login') ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/access-denied') ||
    pathname.startsWith('/mockup') ||
    // Node-state preview gallery (#227) — static node cards, no data; reachable
    // without auth so visual changes can be verified in a browser / Playwright.
    pathname.startsWith('/dev') ||
    // Public documentation site and the AI crawl index. Reachable without auth
    // so external readers and AI crawlers (which point at the raw .md files and
    // /llms.txt) are not redirected to /login.
    pathname.startsWith('/docs') ||
    pathname === '/llms.txt'

  // Allowlist gate — only enforced on protected paths.
  // Public paths (/login, /auth, /access-denied) are exempt so we don't
  // create an infinite redirect loop when sending blocked users to /access-denied.
  if (user && !isPublicPath) {
    const email = user.email ?? ''
    // Step 1: fast domain reject
    const domainOk = email.toLowerCase().endsWith('@trypennie.com')
    if (!domainOk) {
      const url = request.nextUrl.clone()
      url.pathname = '/access-denied'
      return NextResponse.redirect(url)
    }
    // Step 2: DB allowlist check (supabase client has user session, RLS allows authenticated reads)
    const { data: entry } = await supabase
      .from('user_allowlist')
      .select('email')
      .eq('email', email.toLowerCase())
      .maybeSingle()
    if (!entry) {
      const url = request.nextUrl.clone()
      url.pathname = '/access-denied'
      return NextResponse.redirect(url)
    }
  }

  if (!user && !isPublicPath) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  if (user && pathname === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = '/workflows'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
