import { ActionFailure } from '../failure'
import { choice, DRIVE_API, googleJson, googleSend, googleTargetOf, invalid, optionalText, text } from '../google/call'
import { DRIVE_DOWNLOAD_MAX_BYTES } from '../google/limits'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * google.drive-download-file, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * One Drive file's content, as the report parser code steps download the day's
 * file: its metadata first (files.get), then its bytes (alt=media), or for a
 * Google Docs, Sheets or Slides file its export in the `export_mime_type` the
 * step names. Answers `{ id, name, mime_type, size, content }` as UTF-8 text,
 * or `content_base64` when `as` is base64 (a spreadsheet, a PDF). Past
 * DRIVE_DOWNLOAD_MAX_BYTES it fails by name (`google_drive_file_too_large`),
 * before the download when Drive says the size; text that is not UTF-8 is
 * `google_drive_not_text`.
 */

const AS = ['text', 'base64'] as const
const GOOGLE_FILE = 'application/vnd.google-apps.'
const MEDIA_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i

function tooLarge(bytes: number): ActionFailure {
  return new ActionFailure('google_drive_file_too_large', `the file is ${bytes} bytes, over the ${DRIVE_DOWNLOAD_MAX_BYTES} a step reads`, 'not_applied')
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** The body, read until it passes the cap and no further, so an export Drive gave no size for cannot fill the Worker. */
async function readCapped(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (reader === undefined) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > DRIVE_DOWNLOAD_MAX_BYTES) {
      await reader.cancel()
      throw tooLarge(total)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.length
  }
  return bytes
}

export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  googleTargetOf(ctx.target)
  const id = text(args, 'file_id').trim()
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw invalid('file_id must be a Drive file\'s id')
  const as = choice(args, 'as', AS)
  const exportType = optionalText(args, 'export_mime_type')
  if (exportType !== null && !MEDIA_TYPE.test(exportType)) throw invalid('export_mime_type must be a media type, such as text/csv')

  const meta = await googleJson(ctx, {
    method: 'GET', url: `${DRIVE_API}/files/${id}?${new URLSearchParams({ fields: 'id,name,mimeType,size', supportsAllDrives: 'true' }).toString()}`,
    what: 'GET file metadata', effect: 'read',
  })
  const mimeType = typeof meta.mimeType === 'string' ? meta.mimeType : 'application/octet-stream'
  const isGoogleFile = mimeType.startsWith(GOOGLE_FILE)
  if (isGoogleFile && exportType === null) throw invalid('a Google Docs, Sheets or Slides file is downloaded as an export: name its export_mime_type')
  const declared = typeof meta.size === 'string' && /^\d+$/.test(meta.size) ? Number(meta.size) : null
  if (declared !== null && declared > DRIVE_DOWNLOAD_MAX_BYTES) throw tooLarge(declared)

  const url = isGoogleFile
    ? `${DRIVE_API}/files/${id}/export?${new URLSearchParams({ mimeType: exportType as string }).toString()}`
    : `${DRIVE_API}/files/${id}?alt=media&supportsAllDrives=true`
  const { response } = await googleSend(ctx, { method: 'GET', url, what: isGoogleFile ? 'GET file export' : 'GET file content', effect: 'read' }, { accept: '*/*' })
  const bytes = await readCapped(response)
  const out = { id, name: typeof meta.name === 'string' ? meta.name : id, mime_type: isGoogleFile ? (exportType as string) : mimeType, size: bytes.length }
  if (as === 'base64') return { ...out, content_base64: base64(bytes) }
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    throw new ActionFailure('google_drive_not_text', 'the file is not UTF-8 text; download it with as base64', 'not_applied')
  }
  return { ...out, content }
}
