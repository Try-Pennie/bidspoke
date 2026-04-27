'use client'

export const runtime = 'edge'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import NavLayout from '@/components/NavLayout'
import { Shield, KeyRound } from 'lucide-react'

const TABS = [
  { href: '/settings/access', label: 'Access', icon: Shield },
  { href: '/settings/api-keys', label: 'API Keys', icon: KeyRound },
]

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <NavLayout>
      <div className="px-8 pt-8">
        <h1 className="text-3xl font-bold text-graphite">Settings</h1>
        <div className="mt-6 flex items-center gap-1 border-b border-gray-200">
          {TABS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + '/')
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-2 border-b-2 px-3 pb-2.5 pt-1 text-sm font-medium transition-colors ${
                  active
                    ? 'border-p-blue-dark text-graphite'
                    : 'border-transparent text-gray-500 hover:text-gray-800'
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            )
          })}
        </div>
      </div>
      <div className="px-8 pb-8 pt-6">{children}</div>
    </NavLayout>
  )
}
