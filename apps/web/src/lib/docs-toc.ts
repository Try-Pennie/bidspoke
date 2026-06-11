// Heading extraction for the docs "On this page" rail. Works on the raw
// markdown string the docs page already fetched, so the TOC and the rendered
// heading anchors derive from the same source.

export interface TocEntry {
  /** 2 or 3 — H2s are top-level rail entries, H3s nest under them. */
  level: 2 | 3
  text: string
  id: string
}

/**
 * GitHub-style anchor slug: lowercase, inline markdown stripped, spaces to
 * dashes, everything else non-alphanumeric dropped. Must stay in sync with the
 * id the heading components assign — both call this.
 */
export function slugifyHeading(raw: string): string {
  return stripInlineMarkdown(raw)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
}

/** Drop inline code/links/emphasis markers so `code` and [text](url) headings
 * produce readable rail labels and stable slugs. Underscores are kept — they
 * are identifier characters (`timeout_ms`) in these docs, not emphasis. */
export function stripInlineMarkdown(raw: string): string {
  return raw
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*/g, '')
    .trim()
}

/**
 * Extract H2/H3 headings from markdown, skipping fenced code blocks (a `##`
 * inside a fence is a comment, not a heading). H1 is the page title and is
 * excluded — the rail navigates within the page, not to its top.
 */
export function extractHeadings(markdown: string): TocEntry[] {
  const out: TocEntry[] = []
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = line.match(/^(##|###)\s+(.+?)\s*$/)
    if (!m) continue
    const level = m[1].length as 2 | 3
    const text = stripInlineMarkdown(m[2])
    out.push({ level, text, id: slugifyHeading(m[2]) })
  }
  return out
}
