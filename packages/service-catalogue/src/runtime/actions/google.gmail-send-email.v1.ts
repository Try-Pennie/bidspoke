import { ActionFailure } from '../failure'
import { choice, GMAIL_API, googleJson, googleTargetOf, invalid, isObject, optionalText, text } from '../google/call'
import { GMAIL_MAX_RAW_BYTES } from '../google/limits'
import { buildMessage, htmlFromText, textFromHtml, type MailAttachment } from '../google/mime'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * google.gmail-send-email, version 1 (#2337). Released: never edit it; a change
 * is version 2 (the fingerprint check refuses an edit).
 *
 * Pipedream's Send Email (PipedreamHQ/pipedream
 * components/gmail/actions/send-email/send-email.mjs and gmail.app.mjs
 * `getOptionsToSendEmail` and `sendEmail`, at commit b7d67916), sending from the
 * connection's mailbox: to, cc and bcc (a list, or text separated by commas;
 * `me` is the mailbox), a subject, a body as plain text or HTML, a from name,
 * a from address and a reply to address; a reply names the message replied
 * to, whose subject (with Re:), Message-ID and thread it takes, and whose
 * Reply-To or From it answers when no `to` is given. One users.messages.send,
 * Gmail's `{ id, threadId, labelIds }` returned.
 *
 * What differs, on purpose:
 *  - the message ALWAYS carries a text/html alternative beside text/plain,
 *    base64, never quoted-printable (google/mime.ts, L726): a plain body gets an
 *    HTML part written from it, an HTML body a text part read out of it;
 *  - attachments are inline content, `{ filename, content }` as text or
 *    `{ filename, content_base64 }`, with an optional `content_type`: a Worker
 *    has no file path to read, and fetching a URL would leave the connection's
 *    declared hosts;
 *  - reply all is not offered: the one replying step's setting is unknown in the
 *    export, and a reply all reaches people a step did not name;
 *  - a message over GMAIL_MAX_RAW_BYTES is refused by name before anything is sent.
 */

const BODY_TYPES = ['plaintext', 'html'] as const

function addresses(args: ActionArgs, key: string, mailbox: string): string[] {
  const raw = args[key]
  if (raw === undefined || raw === null || raw === '') return []
  const list = typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : null
  if (list === null || !list.every((a): a is string => typeof a === 'string')) throw invalid(`${key} must be a list of addresses, or text separated by commas`)
  return list.map((a) => a.trim()).filter((a) => a !== '').map((a) => (a.toLowerCase() === 'me' ? mailbox : a))
}

function attachmentsOf(args: ActionArgs): MailAttachment[] {
  const raw = args.attachments
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw invalid('attachments must be a list of { filename, content } or { filename, content_base64 }')
  return (raw as readonly JsonValue[]).map((a, i) => {
    if (!isObject(a) || typeof a.filename !== 'string' || a.filename.trim() === '') throw invalid(`attachment ${i + 1} has no filename`)
    const contentType = typeof a.content_type === 'string' && a.content_type !== '' ? a.content_type : 'application/octet-stream'
    if (typeof a.content === 'string') return { filename: a.filename.trim(), contentType, bytes: new TextEncoder().encode(a.content) }
    if (typeof a.content_base64 === 'string') {
      let binary: string
      try {
        binary = atob(a.content_base64)
      } catch {
        throw invalid(`attachment ${i + 1}'s content_base64 is not base64`)
      }
      return { filename: a.filename.trim(), contentType, bytes: Uint8Array.from(binary, (c) => c.charCodeAt(0)) }
    }
    throw invalid(`attachment ${i + 1} has neither content nor content_base64`)
  })
}

/** base64url with no padding, as users.messages.send takes `raw`. */
function base64Url(message: string): string {
  const bytes = new TextEncoder().encode(message)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

interface Replied { subject: string; messageId: string | null; threadId: string; answer: string | null }

async function repliedTo(ctx: ActionContext, id: string): Promise<Replied> {
  const params = ['Subject', 'Message-ID', 'Reply-To', 'From'].map((h) => `metadataHeaders=${h}`).join('&')
  const message = await googleJson(ctx, { method: 'GET', url: `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=metadata&${params}`, what: 'GET the replied to message', effect: 'read' })
  const headers = isObject(message.payload) && Array.isArray(message.payload.headers) ? message.payload.headers.filter(isObject) : []
  const header = (name: string) => {
    const found = headers.find((h) => typeof h.name === 'string' && h.name.toLowerCase() === name)
    return typeof found?.value === 'string' && found.value.trim() !== '' ? found.value : null
  }
  if (typeof message.threadId !== 'string') throw new ActionFailure('google_answer_unreadable', 'Gmail\'s answer for the replied to message named no thread', 'not_applied')
  return { subject: header('subject') ?? '', messageId: header('message-id'), threadId: message.threadId, answer: header('reply-to') ?? header('from') }
}

export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  const { subject: mailbox } = googleTargetOf(ctx.target)
  const body = text(args, 'body')
  const bodyType = choice(args, 'body_type', BODY_TYPES)
  let to = addresses(args, 'to', mailbox)
  const cc = addresses(args, 'cc', mailbox)
  const bcc = addresses(args, 'bcc', mailbox)
  const attachments = attachmentsOf(args)
  const replyId = optionalText(args, 'in_reply_to_message_id')
  let subject = optionalText(args, 'subject')
  if (replyId === null && to.length + cc.length + bcc.length === 0) throw invalid('the email names no recipient: give to, cc or bcc')
  if (replyId === null && subject === null) throw invalid('subject is required unless the email replies to a message')

  // Built once before anything is asked of Gmail, so a message that cannot be sent is refused first.
  const parts = (s: string, recipients: string[], inReplyTo: string | null) => ({
    from: { name: optionalText(args, 'from_name'), address: optionalText(args, 'from_email') ?? mailbox },
    to: recipients, cc, bcc, replyTo: optionalText(args, 'reply_to'), subject: s,
    text: bodyType === 'html' ? textFromHtml(body) : body,
    html: bodyType === 'html' ? body : htmlFromText(body),
    inReplyTo, attachments, boundary: () => `bidspoke-${crypto.randomUUID()}`,
  })
  const check = (message: string) => {
    const bytes = new TextEncoder().encode(message).length
    if (bytes > GMAIL_MAX_RAW_BYTES) throw new ActionFailure('google_gmail_message_too_large', `the message is ${bytes} bytes, over the ${GMAIL_MAX_RAW_BYTES} one send takes`, 'not_applied')
    return message
  }
  check(buildMessage(parts(subject ?? 'Re:', to.length > 0 ? to : [mailbox], replyId === null ? null : '<check@bidspoke>')))

  let threadId: string | null = null
  let inReplyTo: string | null = null
  if (replyId !== null) {
    const replied = await repliedTo(ctx, replyId)
    threadId = replied.threadId
    inReplyTo = replied.messageId
    subject = /^re:/i.test(replied.subject) ? replied.subject : `Re: ${replied.subject}`
    if (to.length === 0 && replied.answer !== null) to = [replied.answer]
    if (to.length + cc.length + bcc.length === 0) throw invalid('the replied to message names no one to answer, and the email names no recipient')
  }
  const raw = base64Url(check(buildMessage(parts(subject ?? '', to, inReplyTo))))
  return googleJson(ctx, {
    method: 'POST',
    url: `${GMAIL_API}/messages/send`,
    body: threadId === null ? { raw } : { raw, threadId },
    what: 'POST messages send',
    effect: 'write',
  })
}
