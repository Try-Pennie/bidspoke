'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

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

export default function DocsPage() {
  const params = useParams()
  const slugParam = params?.slug
  const slug = Array.isArray(slugParam) ? slugParam.join('/') : slugParam || ''
  const currentPath = slug || 'README'

  const [content, setContent] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')

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
    <article className="prose prose-slate max-w-none prose-headings:text-navy prose-a:text-p-blue-dark prose-a:no-underline hover:prose-a:underline prose-pre:bg-navy prose-pre:text-beige prose-pre:rounded-lg">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
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
  )
}
