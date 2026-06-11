'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { extractHeadings, slugifyHeading, type TocEntry } from '@/lib/docs-toc'

export const runtime = 'edge'

// Rewrite an in-repo markdown link to its rendered route.
// `../nodes/filter.md` from page `concepts/overview` -> `/docs/nodes/filter`.
function resolveHref(href: string, currentPath: string): string {
  if (/^(https?:|mailto:|#)/.test(href)) return href
  let stripped = href.replace(/\.md(#.*)?$/, '$1').replace(/\/README(#.*)?$/, '/$1')
  // Resolve relative to the current doc path using the URL API.
  try {
    const base = new URL(`http://d/docs/${currentPath}`)
    const resolved = new URL(stripped, base)
    return resolved.pathname.replace(/\/$/, '') + resolved.hash
  } catch {
    return stripped
  }
}

// Plain text of a heading's React children (text nodes + inline <code>), so
// the rendered anchor id matches what extractHeadings computed from the raw
// markdown line.
function childrenText(children: React.ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(childrenText).join('')
  if (children && typeof children === 'object' && 'props' in children) {
    return childrenText((children as { props: { children?: React.ReactNode } }).props.children)
  }
  return ''
}

// Right-rail "On this page" TOC with scroll-spy. Wide viewports only; pages
// with fewer than 3 headings don't get a rail (nothing to navigate).
function OnThisPage({ headings }: { headings: TocEntry[] }) {
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => {
    const elements = headings
      .map((h) => document.getElementById(h.id))
      .filter((el): el is HTMLElement => el !== null)
    if (elements.length === 0) return
    // The heading nearest below the sticky header wins. The bottom margin
    // keeps a heading "active" until the next one approaches the top band.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting)
        if (visible.length > 0) {
          setActiveId(visible[0].target.id)
        }
      },
      { rootMargin: '-96px 0px -70% 0px' }
    )
    for (const el of elements) observer.observe(el)
    return () => observer.disconnect()
  }, [headings])

  if (headings.length < 3) return null

  return (
    <aside className="hidden w-56 shrink-0 xl:block">
      <nav className="sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto text-sm">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-graphite/50">
          On this page
        </p>
        <ul className="space-y-1 border-l border-graphite/10">
          {headings.map((h, i) => (
            <li key={`${h.id}-${i}`}>
              <a
                href={`#${h.id}`}
                className={`block border-l-2 py-0.5 no-underline ${
                  h.level === 3 ? 'pl-6' : 'pl-3'
                } ${
                  activeId === h.id
                    ? '-ml-px border-p-blue-dark font-medium text-navy'
                    : 'border-transparent text-graphite/70 hover:text-navy'
                }`}
              >
                {h.text}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  )
}

export default function DocsPage() {
  const params = useParams()
  const slugParam = params?.slug
  const slug = Array.isArray(slugParam) ? slugParam.join('/') : slugParam || ''
  const currentPath = slug || 'README'

  const [content, setContent] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const headings = useMemo(() => (content ? extractHeadings(content) : []), [content])

  useEffect(() => {
    let cancelled = false
    setState('loading')
    const base = slug ? `/docs/${slug}` : '/docs/README'

    async function load() {
      // Try `<path>.md`, then `<path>/README.md` for section index links.
      for (const url of [`${base}.md`, `${base}/README.md`]) {
        const res = await fetch(url)
        if (res.ok) {
          const text = await res.text()
          if (!cancelled) {
            setContent(text)
            setState('ok')
          }
          return
        }
      }
      if (!cancelled) setState('error')
    }

    load().catch(() => {
      if (!cancelled) setState('error')
    })
    return () => {
      cancelled = true
    }
  }, [slug])

  if (state === 'loading') {
    return <p className="text-graphite/50">Loading...</p>
  }

  if (state === 'error' || content === null) {
    return (
      <div className="prose prose-graphite">
        <h1>Page not found</h1>
        <p>This documentation page does not exist.</p>
        <p>
          <Link href="/docs">Back to the documentation home</Link>
        </p>
      </div>
    )
  }

  return (
    <div className="flex gap-10">
    <article className="prose prose-slate min-w-0 max-w-none flex-1 prose-headings:text-navy prose-a:text-p-blue-dark prose-a:no-underline hover:prose-a:underline prose-pre:bg-navy prose-pre:text-beige prose-pre:rounded-lg">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Anchor ids on h2/h3 (computed with the same slugify the TOC uses)
          // plus scroll-margin so the sticky header doesn't cover the target.
          h2({ children, ...props }) {
            return (
              <h2 id={slugifyHeading(childrenText(children))} className="scroll-mt-24" {...props}>
                {children}
              </h2>
            )
          },
          h3({ children, ...props }) {
            return (
              <h3 id={slugifyHeading(childrenText(children))} className="scroll-mt-24" {...props}>
                {children}
              </h3>
            )
          },
          code({ className, children, ...props }) {
            // Block code (fenced) is multiline or carries a language class; let it
            // inherit the light color from the dark <pre>. Inline code gets a chip.
            const isBlock = /language-/.test(className || '') || String(children).includes('\n')
            if (isBlock) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              )
            }
            return (
              <code
                className="rounded bg-graphite/10 px-1 py-0.5 font-normal text-navy before:content-none after:content-none"
                {...props}
              >
                {children}
              </code>
            )
          },
          a({ href, children, ...props }) {
            const resolved = href ? resolveHref(href, currentPath) : '#'
            const isInternal = resolved.startsWith('/docs')
            if (isInternal) {
              return (
                <Link href={resolved} {...props}>
                  {children}
                </Link>
              )
            }
            return (
              <a href={resolved} {...props}>
                {children}
              </a>
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </article>
    <OnThisPage headings={headings} />
    </div>
  )
}
