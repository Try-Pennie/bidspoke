'use client'

/**
 * The sell-off offer as it is shown (#2142, the settled design's "As shown"):
 * the title, then the details, which are HTML a person typed (paragraphs and a
 * bulleted list in Sofi's). The details are parsed and rebuilt as React nodes
 * so a script, an event handler or a javascript link in them is never run:
 * - paragraphs, lists, list items, bold, italic and line breaks are kept as
 *   elements, with no attributes;
 * - a link is kept only when it goes to http or https, else it keeps its text;
 * - script, style, iframe, object, embed, img, svg, math, template and
 *   noscript are removed together with everything inside them (DROP);
 * - any other element is dropped and keeps only its text.
 */
import type { ReactNode } from 'react'

const KEEP = new Set(['p', 'ul', 'ol', 'li', 'b', 'strong', 'i', 'em', 'br', 'span'])
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'img', 'svg', 'math', 'template', 'noscript'])

function build(node: Node, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent
  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const el = node as Element
  const tag = el.tagName.toLowerCase()
  if (DROP.has(tag)) return null
  const children = Array.from(el.childNodes).map((c, i) => build(c, `${key}.${i}`))
  if (tag === 'a') {
    const href = el.getAttribute('href') ?? ''
    return /^https?:\/\//i.test(href)
      ? <a key={key} href={href} target="_blank" rel="noopener noreferrer" className="underline">{children}</a>
      : <span key={key}>{children}</span>
  }
  if (tag === 'br') return <br key={key} />
  if (tag === 'p') return <p key={key} className="mb-1.5 last:mb-0">{children}</p>
  if (tag === 'ul') return <ul key={key} className="list-disc pl-5">{children}</ul>
  if (tag === 'ol') return <ol key={key} className="list-decimal pl-5">{children}</ol>
  if (KEEP.has(tag)) {
    const Tag = tag as 'li' | 'b' | 'strong' | 'i' | 'em' | 'span'
    return <Tag key={key}>{children}</Tag>
  }
  return <span key={key}>{children}</span>
}

export function OfferPreview({ title, details }: { title: string; details: string }) {
  if (title.trim() === '' && details.trim() === '') {
    return <p className="text-sm text-gray-600">Nothing to show until a title or details are filled in.</p>
  }
  const body = new DOMParser().parseFromString(details, 'text/html').body
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3.5 py-3 text-sm text-graphite">
      {title.trim() !== '' && <div className="mb-1.5 font-semibold">{title}</div>}
      <div>{Array.from(body.childNodes).map((c, i) => build(c, String(i)))}</div>
    </div>
  )
}
