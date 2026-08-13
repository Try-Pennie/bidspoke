import { truncateKeepingTail } from './truncate-text'

/**
 * Collapse an upstream HTML error page down to the signal it carries (#695).
 *
 * When Salesforce Edge fails, it answers with HTTP 400 and a full branded error
 * page: two inlined stylesheets, an SVG illustration, a logo, roughly 16.7KB in
 * the production rows this was measured from. The engine stored that page
 * verbatim in `execution_steps.error_message`, so the execution detail page
 * showed a wall of markup and the only useful parts (the message, the request
 * ID, the timestamp, the pod, the status, and which system produced the page)
 * were unreachable without querying the database by hand.
 *
 * The rule is deliberately generic rather than Salesforce specific: any vendor
 * that answers an API call with an HTML document is reporting an infrastructure
 * failure, and the readable text of that document is the whole of what we want.
 */

// An HTML DOCUMENT, not merely markup-looking text. An error message can easily
// contain angle brackets ("Expected <number>, got ...") or an XML fault body,
// and neither is a page: rewriting those would lose real detail. Note the real
// Salesforce page serves `<!doctypehtml>` with no space, so the space is optional.
const HTML_DOCUMENT_MARKER = /<!doctype\s*html|<html[\s>]/i

/** Blocks whose contents are never human-readable signal. */
const OPAQUE_BLOCKS = /<(script|style|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi

// Budget for the extracted text. The head keeps the message, the tail keeps the
// request-ID stamp, which is what Salesforce support asks for.
const MAX_VISIBLE_CHARS = 500
const VISIBLE_TAIL_CHARS = 140

export function containsHtmlDocument(text: string): boolean {
  return HTML_DOCUMENT_MARKER.test(text)
}

/**
 * Returns `message` unchanged unless it contains an HTML document, in which case
 * the document is replaced by its readable text plus a note of how many bytes
 * were collapsed. Any prefix the caller built ("Salesforce API error (400): ")
 * is preserved, so the status code and the failing operation survive.
 *
 * Idempotent: the output contains no markup, so re-running it is a no-op. That
 * matters because formatErr can render an already-summarized message again.
 */
export function summarizeHtmlErrorBody(message: string): string {
  const match = HTML_DOCUMENT_MARKER.exec(message)
  if (!match) return message

  const prefix = message.slice(0, match.index).trim()
  const html = message.slice(match.index)
  const visible = truncateKeepingTail(extractVisibleText(html), MAX_VISIBLE_CHARS, VISIBLE_TAIL_CHARS)

  // Always state that a page was collapsed and how big it was. Without this a
  // reader cannot tell a terse upstream message from one we shortened.
  const note = `[HTML error page, ${html.length} bytes]`
  return [prefix, visible, note].filter((part) => part !== '').join(' ')
}

function extractVisibleText(html: string): string {
  const stripped = html
    .replace(OPAQUE_BLOCKS, ' ')
    .replace(/<[^>]*>/g, ' ')
  // Decode after stripping tags, so an escaped bracket in the page's own text
  // survives instead of being eaten as markup.
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim()
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'")
    // &amp; last, so "&amp;lt;" renders as "&lt;" rather than decoding twice.
    .replace(/&amp;/gi, '&')
}
