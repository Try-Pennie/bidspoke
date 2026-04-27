'use client'

import Image from 'next/image'
import Link from 'next/link'

import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { GitBranch, Settings, LogOut, Puzzle, KeyRound, Users, LayoutDashboard, Globe } from 'lucide-react'

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/workflows', label: 'Workflows', icon: GitBranch },
  { href: '/partners', label: 'Partners', icon: Users },
  { href: '/endpoints', label: 'Endpoints', icon: Globe },
  { href: '/env', label: 'Environment', icon: Settings },
  { href: '/sources', label: 'API Sources', icon: KeyRound },
  { href: '/integrations', label: 'Integrations', icon: Puzzle },
]

export default function NavLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()

  async function handleSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <div className="flex min-h-screen">
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
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + '/')
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-white/10 text-white'
                    : 'text-white/60 hover:bg-white/5 hover:text-white/80'
                }`}
              >
                <Icon className={`h-4 w-4 ${active ? 'text-p-blue' : 'text-white/40'}`} />
                {label}
              </Link>
            )
          })}
        </div>
        <div className="border-t border-white/10 px-2 py-4 space-y-0.5">
          <Link
            href="/settings"
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              pathname === '/settings' || pathname.startsWith('/settings/')
                ? 'bg-white/10 text-white'
                : 'text-white/50 hover:bg-white/5 hover:text-white/80'
            }`}
          >
            <Settings className={`h-4 w-4 ${pathname === '/settings' || pathname.startsWith('/settings/') ? 'text-p-blue' : 'text-white/40'}`} />
            Settings
          </Link>
          <button
            onClick={handleSignOut}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-white/50 transition-colors hover:bg-white/5 hover:text-white/80"
          >
            <LogOut className="h-4 w-4 text-white/40" />
            Sign out
          </button>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex flex-1 flex-col overflow-auto">{children}</main>
    </div>
  )
}
