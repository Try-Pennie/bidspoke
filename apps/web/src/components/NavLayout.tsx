'use client'

import Image from 'next/image'
import Link from 'next/link'

import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { leaveThen } from '@/lib/leave-guard'
import { GitBranch, Settings, LogOut, Plug, KeyRound, Users, LayoutDashboard, Globe, BookOpen } from 'lucide-react'

// Integrations became Connections, with a plug (#2338, R2, D2). The old
// Integrations page stays reachable, from the Slack alert login on the
// Connections page, until build PR 14 moves its alert settings and retires it.
const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, iconName: 'layout-dashboard' },
  { href: '/workflows', label: 'Workflows', icon: GitBranch, iconName: 'git-branch' },
  { href: '/partners', label: 'Partners', icon: Users, iconName: 'users' },
  { href: '/endpoints', label: 'Endpoints', icon: Globe, iconName: 'globe' },
  { href: '/env', label: 'Environment', icon: Settings, iconName: 'settings' },
  { href: '/sources', label: 'API Sources', icon: KeyRound, iconName: 'key-round' },
  { href: '/connections', label: 'Connections', icon: Plug, iconName: 'plug' },
]

/**
 * `activeHref` draws that item as the current page wherever the layout is
 * rendered: only the development preview of a page sets it (/dev/connections),
 * so its picture matches the page as served.
 */
export default function NavLayout({ children, activeHref }: { children: React.ReactNode; activeHref?: string }) {
  const routePath = usePathname()
  const pathname = activeHref ?? routePath
  const router = useRouter()

  // A page holding unsaved work asks first, in its own dialog (#2138, PM-5).
  function handleSignOut() {
    leaveThen({ kind: 'sign-out' }, () => {
      void (async () => {
        const supabase = createClient()
        await supabase.auth.signOut()
        router.push('/login')
      })()
    })
  }

  return (
    <div className="flex min-h-screen">
      {/* Skip link: first tab stop, visually hidden until focused, so keyboard
          users can jump past the sidebar straight to the page content (#288). */}
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-navy px-4 py-2 text-sm font-medium text-white focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:outline-none focus:ring-2 focus:ring-p-blue-dark focus:ring-offset-2"
      >
        Skip to main content
      </a>
      {/* Sidebar */}
      <nav className="flex w-52 flex-col bg-navy">
        <div className="flex items-center gap-2.5 px-4 py-5">
          <Image
            src="/icon-dark.png"
            alt="Bidspoke"
            width={26}
            height={26}
            className="flex-shrink-0"
          />
          <span className="text-lg font-semibold tracking-tight text-white">Bidspoke</span>
        </div>
        <div className="flex-1 space-y-0.5 px-2 py-2">
          {NAV.map(({ href, label, icon: Icon, iconName }) => {
            const active = pathname === href || pathname.startsWith(href + '/')
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-white/10 text-white'
                    : 'text-white/70 hover:bg-white/5 hover:text-white'
                }`}
              >
                <Icon data-icon={iconName} className={`h-4 w-4 ${active ? 'text-p-blue' : 'text-white/60'}`} />
                {label}
              </Link>
            )
          })}
        </div>
        <div className="border-t border-white/10 px-2 py-4 space-y-0.5">
          <a
            href="/docs"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-white/70 transition-colors hover:bg-white/5 hover:text-white"
          >
            <BookOpen className="h-4 w-4 text-white/60" />
            Docs
          </a>
          <Link
            href="/settings"
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              pathname === '/settings' || pathname.startsWith('/settings/')
                ? 'bg-white/10 text-white'
                : 'text-white/70 hover:bg-white/5 hover:text-white'
            }`}
          >
            <Settings className={`h-4 w-4 ${pathname === '/settings' || pathname.startsWith('/settings/') ? 'text-p-blue' : 'text-white/60'}`} />
            Settings
          </Link>
          <button
            onClick={handleSignOut}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-white/70 transition-colors hover:bg-white/5 hover:text-white"
          >
            <LogOut className="h-4 w-4 text-white/60" />
            Sign out
          </button>
        </div>
      </nav>

      {/* Main content */}
      <main id="main-content" tabIndex={-1} className="flex flex-1 flex-col overflow-auto focus:outline-none">{children}</main>
    </div>
  )
}
