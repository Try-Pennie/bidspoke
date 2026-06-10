'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

type NavEntry = { slug: string; path: string; title: string; section: string }

const SECTION_ORDER = ['root', 'concepts', 'nodes', 'guides', 'reference', 'examples']
const SECTION_LABELS: Record<string, string> = {
  root: 'Overview',
  concepts: 'Concepts',
  nodes: 'Nodes',
  guides: 'Guides',
  reference: 'Reference',
  examples: 'Examples',
}

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const [nav, setNav] = useState<NavEntry[]>([])
  const pathname = usePathname()

  useEffect(() => {
    fetch('/docs/_nav.json')
      .then((r) => (r.ok ? r.json() : []))
      .then(setNav)
      .catch(() => setNav([]))
  }, [])

  const sections = SECTION_ORDER.map((key) => ({
    key,
    label: SECTION_LABELS[key] ?? key,
    // README pages sort first within a section; otherwise alphabetical by title.
    entries: nav
      .filter((e) => e.section === key)
      .sort((a, b) => {
        const ar = a.path.endsWith('README.md') ? 0 : 1
        const br = b.path.endsWith('README.md') ? 0 : 1
        return ar - br || a.title.localeCompare(b.title)
      }),
  })).filter((s) => s.entries.length > 0)

  return (
    <div className="min-h-screen bg-beige text-graphite">
      <header className="sticky top-0 z-20 border-b border-graphite/10 bg-beige shadow-sm">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6 py-4">
          <Link href="/docs" className="font-semibold text-navy no-underline">
            Bidspoke Docs
          </Link>
          <Link href="/workflows" className="text-sm text-p-blue-dark no-underline hover:underline">
            Open the app
          </Link>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1400px] gap-10 px-6 py-10">
        <aside className="hidden w-60 shrink-0 lg:block">
          <nav className="sticky top-24 space-y-6 text-sm">
            {sections.map((section) => (
              <div key={section.key}>
                <p className="mb-2 font-semibold uppercase tracking-wide text-graphite/50 text-xs">
                  {section.label}
                </p>
                <ul className="space-y-1">
                  {section.entries.map((entry) => {
                    const href = `/docs/${entry.slug}`.replace(/\/$/, '') || '/docs'
                    const active = pathname === href
                    return (
                      <li key={entry.slug}>
                        <Link
                          href={href}
                          className={`block rounded px-2 py-1 no-underline ${
                            active
                              ? 'bg-p-blue-light text-navy font-medium'
                              : 'text-graphite/80 hover:bg-graphite/5'
                          }`}
                        >
                          {entry.title}
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  )
}
