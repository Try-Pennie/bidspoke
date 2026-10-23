import { invalid } from './call'

/**
 * The RFC 5322 message gmail-send-email sends (#2337), built here rather than
 * with nodemailer's MailComposer, which Pipedream's Gmail app used
 * (components/gmail/gmail.app.mjs `sendEmail`, at commit b7d67916) and which a
 * Worker does not carry.
 *
 * ALWAYS a text/html alternative beside text/plain, each base64 in UTF-8, never
 * quoted-printable: Gmail's send API drops quoted-printable and hard wraps a
 * plain text body at about 72 characters (L726), and an HTML part is what keeps
 * a long line whole. A plain text body gets an HTML part written from it
 * (escaped, its line breaks kept), and an HTML body a text part read out of it.
 * With attachments the alternatives sit inside multipart/mixed. A line break in
 * any header value is refused, so no value can add a header.
 */

export interface MailAttachment {
  readonly filename: string
  readonly contentType: string
  readonly bytes: Uint8Array
}

export interface MailParts {
  readonly from: { readonly name: string | null; readonly address: string }
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly bcc: readonly string[]
  readonly replyTo: string | null
  readonly subject: string
  readonly text: string
  readonly html: string
  /** The Message-ID of the message replied to, with its angle brackets. */
  readonly inReplyTo: string | null
  readonly attachments: readonly MailAttachment[]
  /** A fresh boundary each call; injected so a test reads the same message every time. */
  readonly boundary: () => string
}

const LINE_BREAK = /[\r\n]/
const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/
const NAMED = /^(.*?)\s*<([^<>]+)>$/
const NOT_ASCII = /[^\x20-\x7e]/

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** base64 in lines of 76, as RFC 2045 asks. */
function base64Lines(bytes: Uint8Array): string {
  return (bytesToBase64(bytes).match(/.{1,76}/g) ?? ['']).join('\r\n')
}

function headerValue(name: string, value: string): string {
  if (LINE_BREAK.test(value)) throw invalid(`${name} must be one line`)
  return value
}

/** A header word in UTF-8 when it is not plain ASCII (RFC 2047). */
function encodedWord(value: string): string {
  return NOT_ASCII.test(value) ? `=?UTF-8?B?${bytesToBase64(new TextEncoder().encode(value))}?=` : value
}

/** One address, bare or `Name <address>`, checked, its name encoded when it is not ASCII. */
export function mailbox(raw: string, what: string): string {
  const value = headerValue(what, raw).trim()
  const named = NAMED.exec(value)
  const address = named ? named[2].trim() : value
  if (!ADDRESS.test(address)) throw invalid(`${what} holds something that is not an email address`)
  if (!named || named[1].trim() === '') return address
  const name = named[1].trim().replace(/^"(.*)"$/, '$1')
  if (name.includes('"') || name.includes('\\')) throw invalid(`${what} holds a display name with a quote in it`)
  return `${encodedWord(name)} <${address}>`
}

function fromHeader(from: MailParts['from']): string {
  const address = mailbox(from.address, 'from_email')
  if (from.name === null || from.name.trim() === '') return address
  const name = headerValue('from_name', from.name).trim()
  if (name.includes('"') || name.includes('\\')) throw invalid('from_name holds a quote')
  return NOT_ASCII.test(name) ? `${encodedWord(name)} <${address}>` : `"${name}" <${address}>`
}

function textPart(contentType: string, body: string): string {
  return `Content-Type: ${contentType}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(new TextEncoder().encode(body))}`
}

function multipart(kind: string, boundary: string, bodies: string[]): { header: string; body: string } {
  return { header: `multipart/${kind}; boundary="${boundary}"`, body: `${bodies.map((b) => `--${boundary}\r\n${b}\r\n`).join('')}--${boundary}--` }
}

function attachmentPart(a: MailAttachment): string {
  const filename = headerValue('an attachment\'s filename', a.filename)
  if (filename.includes('"') || NOT_ASCII.test(filename)) throw invalid('an attachment\'s filename must be plain ASCII with no quote')
  const type = headerValue('an attachment\'s content type', a.contentType)
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(type)) throw invalid('an attachment\'s content type must be a media type, such as text/csv')
  return `Content-Type: ${type}; name="${filename}"\r\nContent-Disposition: attachment; filename="${filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(a.bytes)}`
}

/** The whole message, CRLF line endings, ready to be base64url encoded for users.messages.send. */
export function buildMessage(parts: MailParts): string {
  const headers = [`From: ${fromHeader(parts.from)}`]
  const list = (name: string, values: readonly string[]) => {
    if (values.length > 0) headers.push(`${name}: ${values.map((v) => mailbox(v, name.toLowerCase())).join(', ')}`)
  }
  list('To', parts.to)
  list('Cc', parts.cc)
  list('Bcc', parts.bcc)
  if (parts.replyTo !== null) headers.push(`Reply-To: ${mailbox(parts.replyTo, 'reply_to')}`)
  headers.push(`Subject: ${encodedWord(headerValue('subject', parts.subject))}`)
  if (parts.inReplyTo !== null) {
    const id = headerValue('the replied to message id', parts.inReplyTo)
    headers.push(`In-Reply-To: ${id}`, `References: ${id}`)
  }
  headers.push('MIME-Version: 1.0')

  const alternative = multipart('alternative', parts.boundary(), [textPart('text/plain', parts.text), textPart('text/html', parts.html)])
  const attachments = parts.attachments.map(attachmentPart)
  if (attachments.length === 0) return `${headers.join('\r\n')}\r\nContent-Type: ${alternative.header}\r\n\r\n${alternative.body}`
  const mixed = multipart('mixed', parts.boundary(), [`Content-Type: ${alternative.header}\r\n\r\n${alternative.body}`, ...attachments])
  return `${headers.join('\r\n')}\r\nContent-Type: ${mixed.header}\r\n\r\n${mixed.body}`
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': '\'', apos: '\'', nbsp: ' ' }

/** The text of an HTML body, for its text/plain alternative: blocks become lines, tags and scripts go, entities are read. */
export function textFromHtml(html: string): string {
  return html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_m, e: string) => ENTITIES[e])
    .split('\n').map((line) => line.trim()).filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== '')).join('\n')
    .trim()
}

/** A plain text body as HTML, for its text/html alternative: escaped, each line break kept as <br>. */
export function htmlFromText(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<div dir="ltr">${escaped.replace(/\r?\n/g, '<br>\n')}</div>`
}
