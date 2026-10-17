'use client'

/**
 * The sell-off offer as it is shown (#2142, the settled design's "As shown"):
 * the title, then the details, which are HTML a person typed (paragraphs and a
 * bulleted list in Sofi's). The details are parsed and rebuilt as React nodes
 * so a script, an event handler or a javascript link in them is never run:
 * - paragraphs, lists, list items, bold, italic and line breaks are kept as
 *   elements, with no attributes;
 * - a link is kept only when it goes to http or https, else it becomes a plain
 *   span with its contents;
 * - script, style, iframe, object, embed, img, svg, math, template and
 *   noscript are removed together with everything inside them (DROP);
 * - any other element (a div, a span, a heading) becomes a plain span with no
 *   attributes, its contents built by these same rules.
 */
import type { ReactNode } from 'react'

/** The plain elements rebuilt as themselves; p, ul, ol, br and a have their own branches below. */
const KEEP = new Set(['li', 'b', 'strong', 'i', 'em'])
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
    const Tag = tag as 'li' | 'b' | 'strong' | 'i' | 'em'
    return <Tag key={key}>{children}</Tag>
  }
  return <span key={key}>{children}</span>
}

/**
 * The card is always drawn, as the settled design draws it (#2327, PM-24).
 * With nothing filled in it holds `example`, the boxes' own placeholders, in
 * the hint grey a placeholder is drawn in, so the card reads as an example and
 * never as an offer someone wrote; a screen reader is told so first.
 */
export function OfferPreview({ title, details, example }: { title: string; details: string; example?: { title: string; details: string } }) {
  const empty = title.trim() === '' && details.trim() === ''
  const shown = empty && example ? example : { title, details }
  const body = new DOMParser().parseFromString(shown.details, 'text/html').body
  const tone = empty ? 'text-hint' : ''
  return (
    <div data-offer-preview data-example={empty ? 'true' : 'false'} className="rounded-lg border border-line bg-white px-3.5 py-3 text-[13px] text-graphite">
      {empty && <span className="sr-only">Nothing is filled in yet. An example: </span>}
      {shown.title.trim() !== '' && <div className={`mb-1.5 font-semibold ${tone}`.trim()}>{shown.title}</div>}
      <div className={tone || undefined}>{Array.from(body.childNodes).map((c, i) => build(c, String(i)))}</div>
    </div>
  )
}
