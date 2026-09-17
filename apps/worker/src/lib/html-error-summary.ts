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
 * A partner's firewall answering with a block page instead of data (#1265).
 *
 * Achieve's Cloudflare firewall refused every call from the worker for five days with a 403
 * HTML page and nothing recognised it. The rule here is deliberately narrow, because the
 * obvious evidence is not evidence: EVERY response that passes through Cloudflare carries a
 * `cf-ray` header, and Cloudflare's own origin-error pages (502, 504, 520 to 526) carry a
 * Ray ID and the word "cloudflare" too, while meaning the partner's server is down rather
 * than that it is blocking us. Both live buyers' endpoints are proxy workers on our own
 * zone, so the header Ray ID on those responses is ours, not the partner's.
 *
 * So a block is recognised only on the markers a block or challenge page carries, the
 * Ray ID is read from the page BODY (the author's, the one the partner's firewall log
 * holds) and the header Ray ID is reported separately as the edge in front of the host.
 * A 403 HTML page with none of those markers is reported as exactly that, an HTML page
 * where data was expected, with `vendor: 'unknown'`, so the alert can claim only what
 * was measured. Anything else returns null and the HTML page rule alone applies.
 */
export interface BlockPage {
  status: number
  vendor: 'cloudflare' | 'unknown'
  /** From the page body: the author's Ray ID, the one to quote to the partner. */
  bodyRayId: string | null
  /** From the cf-ray header: the edge in front of the host we called. */
  edgeRayId: string | null
  /** The markers that made this a block, for the alert and the log line. */
  markers: string[]
}

type HeaderReader = { get(name: string): string | null } | Record<string, string>

const BLOCK_BODY_MARKERS: ReadonlyArray<{ marker: string; test: RegExp }> = [
  { marker: 'Sorry, you have been blocked', test: /sorry, you have been blocked/i },
  { marker: 'Attention Required | Cloudflare', test: /attention required!?\s*\|\s*cloudflare/i },
  // Cloudflare's access-denied error codes: 1006/1007/1008 IP banned, 1010 browser
  // signature banned, 1012 access denied, 1020 firewall rule.
  { marker: 'Cloudflare error code 10xx', test: /error code:?\s*10(?:06|07|08|10|12|20)\b/i },
  { marker: 'Cloudflare challenge page', test: /just a moment|checking your browser|cf-chl/i },
]

const RAY_ID_IN_TEXT = /ray id:?\s*([0-9a-f]{16})\b/i

function readHeader(headers: HeaderReader | undefined, name: string): string | null {
  if (!headers) return null
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(name: string): string | null }).get(name)
  }
  const record = headers as Record<string, string>
  const key = Object.keys(record).find((k) => k.toLowerCase() === name)
  return key === undefined ? null : record[key]
}

export function detectBlockPage(
  status: number,
  bodyText: string | null | undefined,
  headers?: HeaderReader,
): BlockPage | null {
  if (status < 400) return null
  if (typeof bodyText !== 'string' || bodyText.length === 0 || !containsHtmlDocument(bodyText)) return null

  const visible = extractVisibleText(bodyText)
  const markers = BLOCK_BODY_MARKERS.filter(({ test }) => test.test(visible) || test.test(bodyText)).map(({ marker }) => marker)
  const mitigated = readHeader(headers, 'cf-mitigated')
  if (mitigated) markers.push(`cf-mitigated: ${mitigated}`)

  let vendor: BlockPage['vendor']
  if (markers.length > 0) vendor = 'cloudflare'
  else if (status === 403) vendor = 'unknown'
  else return null

  return {
    status,
    vendor,
    bodyRayId: RAY_ID_IN_TEXT.exec(visible)?.[1]?.toLowerCase() ?? null,
    edgeRayId: readHeader(headers, 'cf-ray'),
    markers,
  }
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
