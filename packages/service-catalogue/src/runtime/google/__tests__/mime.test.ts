import { describe, expect, it } from 'vitest'
import { ActionFailure } from '../../failure'
import { buildMessage, htmlFromText, textFromHtml, type MailParts } from '../mime'

/**
 * The message gmail-send-email builds (#2337), judged by its built parts (the
 * delivered message is #2339's proof). Gmail drops quoted-printable and hard
 * wraps a plain text body at about 72 characters (L726), so every message
 * carries a text/html part beside text/plain, each base64, never
 * quoted-printable.
 */

interface Part { headers: Record<string, string>; body: string }

/** Splits a MIME entity into its headers and body. */
function entity(raw: string): Part {
  const at = raw.indexOf('\r\n\r\n')
  const head = raw.slice(0, at).replace(/\r\n[ \t]/g, ' ')
  const headers: Record<string, string> = {}
  for (const line of head.split('\r\n')) {
    const i = line.indexOf(':')
    headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim()
  }
  return { headers, body: raw.slice(at + 4) }
}

/** The parts of a multipart body, by its boundary. */
function parts(p: Part): Part[] {
  const boundary = /boundary="([^"]+)"/.exec(p.headers['content-type'])![1]
  return p.body.split(`--${boundary}`).slice(1, -1).map((chunk) => entity(chunk.replace(/^\r\n/, '').replace(/\r\n$/, '')))
}

const decode = (body: string) => new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\r\n/g, '')), (c) => c.charCodeAt(0)))

let n = 0
const BASE: MailParts = {
  from: { name: 'Pennie Ops', address: 'ops@trypennie.com' },
  to: ['partner@lender.example'],
  cc: [],
  bcc: [],
  replyTo: null,
  subject: 'Daily bid report',
  text: 'Hello,\nthe report is attached.',
  html: htmlFromText('Hello,\nthe report is attached.'),
  inReplyTo: null,
  attachments: [],
  boundary: () => `b${++n}`,
}

describe('buildMessage', () => {
  it('always builds text/plain and text/html alternatives, each base64 in UTF-8, never quoted-printable (L726)', () => {
    const msg = entity(buildMessage(BASE))
    expect(msg.headers['mime-version']).toBe('1.0')
    expect(msg.headers['content-type']).toMatch(/^multipart\/alternative; boundary="b\d+"$/)
    const [plain, html] = parts(msg)
    expect(plain.headers['content-type']).toBe('text/plain; charset="UTF-8"')
    expect(html.headers['content-type']).toBe('text/html; charset="UTF-8"')
    for (const p of [plain, html]) {
      expect(p.headers['content-transfer-encoding']).toBe('base64')
      expect(p.body.split('\r\n').every((line) => line.length <= 76)).toBe(true)
    }
    expect(buildMessage(BASE)).not.toMatch(/quoted-printable/i)
    expect(decode(plain.body)).toBe('Hello,\nthe report is attached.')
    expect(decode(html.body)).toContain('Hello,<br>')
  })

  it('a long plain line stays whole in the text part, which is base64, so nothing wraps it at 72', () => {
    const long = 'x'.repeat(300)
    const [plain] = parts(entity(buildMessage({ ...BASE, text: long, html: htmlFromText(long) })))
    expect(decode(plain.body)).toBe(long)
  })

  it('writes the address headers, a display name quoted, and a non ASCII subject as an encoded word', () => {
    const msg = entity(buildMessage({ ...BASE, to: ['a@x.example', 'Bea Lee <b@x.example>'], cc: ['c@x.example'], bcc: ['d@x.example'], replyTo: 'r@x.example', subject: 'Résumé, café' }))
    expect(msg.headers.from).toBe('"Pennie Ops" <ops@trypennie.com>')
    expect(msg.headers.to).toBe('a@x.example, Bea Lee <b@x.example>')
    expect(msg.headers.cc).toBe('c@x.example')
    expect(msg.headers.bcc).toBe('d@x.example')
    expect(msg.headers['reply-to']).toBe('r@x.example')
    expect(msg.headers.subject).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
    expect(decode(msg.headers.subject.slice(10, -2))).toBe('Résumé, café')
  })

  it('a reply carries In-Reply-To and References', () => {
    const msg = entity(buildMessage({ ...BASE, inReplyTo: '<abc@mail.gmail.com>' }))
    expect(msg.headers['in-reply-to']).toBe('<abc@mail.gmail.com>')
    expect(msg.headers.references).toBe('<abc@mail.gmail.com>')
  })

  it('with attachments, wraps the alternatives in multipart/mixed and attaches each file base64', () => {
    const msg = entity(buildMessage({ ...BASE, attachments: [{ filename: 'report.csv', contentType: 'text/csv', bytes: new TextEncoder().encode('id,bid\n1,42\n') }] }))
    expect(msg.headers['content-type']).toMatch(/^multipart\/mixed; boundary=/)
    const [alternative, file] = parts(msg)
    expect(alternative.headers['content-type']).toMatch(/^multipart\/alternative/)
    expect(parts(alternative)).toHaveLength(2)
    expect(file.headers['content-type']).toBe('text/csv; name="report.csv"')
    expect(file.headers['content-disposition']).toBe('attachment; filename="report.csv"')
    expect(decode(file.body)).toBe('id,bid\n1,42\n')
  })

  it('refuses a line break in any header value, so a value cannot add a header', () => {
    const cases: Array<Partial<MailParts>> = [
      { subject: 'Hi\r\nBcc: evil@x.example' },
      { to: ['a@x.example\nBcc: evil@x.example'] },
      { from: { name: 'Ops\r\nX: y', address: 'ops@trypennie.com' } },
      { replyTo: 'r@x.example\r\n' },
      { attachments: [{ filename: 'a\r\n.csv', contentType: 'text/csv', bytes: new Uint8Array() }] },
    ]
    for (const over of cases) {
      let thrown: unknown
      try {
        buildMessage({ ...BASE, ...over })
      } catch (err) {
        thrown = err
      }
      expect(thrown, JSON.stringify(over)).toBeInstanceOf(ActionFailure)
      expect((thrown as ActionFailure).code).toBe('google_argument_invalid')
    }
  })
})

describe('the two bodies', () => {
  it('reads plain text out of HTML for the text part', () => {
    expect(textFromHtml('<p>Hello <b>Sam</b>,</p><p>Bids: 3 &amp; up</p><br><style>p{}</style>')).toBe('Hello Sam,\nBids: 3 & up')
  })

  it('writes plain text as HTML for the html part, escaped, its line breaks kept', () => {
    expect(htmlFromText('a < b & c\nnext')).toBe('<div dir="ltr">a &lt; b &amp; c<br>\nnext</div>')
  })
})
