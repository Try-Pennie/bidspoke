'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { GitBranch, Settings, LogOut, Puzzle, KeyRound, Users, Shield, LayoutDashboard } from 'lucide-react'

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/workflows', label: 'Workflows', icon: GitBranch },
  { href: '/partners', label: 'Partners', icon: Users },
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
      <nav className="flex w-52 flex-col bg-slate-900">
        <div className="flex items-center gap-2.5 px-4 py-5">
          <Image
            src="/icon-dark.png"
            alt="Bidspoke"
            width={26}
            height={26}
            className="flex-shrink-0"
          />
          <span className="text-lg font-bold tracking-tight text-white">Bidspoke</span>
        </div>
        <div className="flex-1 space-y-0.5 px-2 py-2">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + '/')
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                }`}
              >
                <Icon className={`h-4 w-4 ${active ? 'text-indigo-400' : 'text-slate-500'}`} />
                {label}
              </Link>
            )
          })}
        </div>
        <div className="border-t border-slate-700/60 px-2 py-4 space-y-0.5">
          <Link
            href="/access"
            className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              pathname === '/access'
                ? 'bg-slate-800 text-white'
                : 'text-slate-500 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            <Shield className={`h-4 w-4 ${pathname === '/access' ? 'text-indigo-400' : 'text-slate-500'}`} />
            Access
          </Link>
          <button
            onClick={handleSignOut}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex flex-1 flex-col overflow-auto">{children}</main>
    </div>
  )
}
