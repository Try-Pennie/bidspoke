'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { GitBranch, Settings, LogOut, Puzzle, KeyRound, Users, Shield } from 'lucide-react'

const NAV = [
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
      <nav className="flex w-52 flex-col border-r border-gray-200 bg-white">
        <div className="flex items-center gap-2.5 px-4 py-5">
          <Image
            src="/icon-light.png"
            alt="Bidspoke"
            width={26}
            height={26}
            className="flex-shrink-0"
            style={{ mixBlendMode: 'multiply' }}
          />
          <span className="text-lg font-bold tracking-tight text-gray-900">Bidspoke</span>
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
                    ? 'bg-gray-100 text-gray-900'
                    : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <Icon className={`h-4 w-4 ${active ? 'text-gray-700' : 'text-gray-400'}`} />
                {label}
              </Link>
            )
          })}
        </div>
        <div className="border-t border-gray-100 px-2 py-4 space-y-0.5">
          <Link
            href="/access"
            className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              pathname === '/access'
                ? 'bg-gray-100 text-gray-900'
                : 'text-gray-400 hover:bg-gray-50 hover:text-gray-700'
            }`}
          >
            <Shield className="h-4 w-4" />
            Access
          </Link>
          <button
            onClick={handleSignOut}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-700"
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
