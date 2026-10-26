import { ActionFailure } from '../failure'
import { choice, DRIVE_API, googleJson, googleSend, googleTargetOf, invalid, optionalText, text, unreadable, type GoogleRequest } from '../google/call'
import { base64, driveNotDeclared, fileDriveOf, fileTooLarge, readCapped } from '../google/drive'
import { DRIVE_DOWNLOAD_MAX_BYTES } from '../google/limits'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * google.drive-download-file, version 2 (#2805). Released: never edit it; a
 * change is version 3 (the fingerprint check refuses an edit).
 *
 * Version 1's download, with the connection's own drive list held in the
 * action (Dan's decision of 2026-10-26): the metadata request also reads which
 * shared drive the file is in (files.get with supportsAllDrives and driveId),
 * and a file in a shared drive the connection does not declare is refused by
 * name (`google_drive_not_declared`, naming the drive) before a byte of it is
 * asked for. A file in no shared drive, the mailbox's own, is always read. A
 * 403 or 404 on the lookup is Google's own refusal, by its status, not applied.
 *
 * Otherwise as version 1: the bytes (alt=media), or a Google Docs, Sheets or
 * Slides file's export in `export_mime_type`; `{ id, name, mime_type, size,
 * content }` as UTF-8 text, or `content_base64` when `as` is base64; past
 * DRIVE_DOWNLOAD_MAX_BYTES `google_drive_file_too_large`, before the download
 * when Drive says the size; text that is not UTF-8 `google_drive_not_text`.
 */

const AS = ['text', 'base64'] as const
const GOOGLE_FILE = 'application/vnd.google-apps.'
const MEDIA_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i

export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  const { drives } = googleTargetOf(ctx.target)
  const id = text(args, 'file_id').trim()
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw invalid('file_id must be a Drive file\'s id')
  const as = choice(args, 'as', AS)
  const exportType = optionalText(args, 'export_mime_type')
  if (exportType !== null && !MEDIA_TYPE.test(exportType)) throw invalid('export_mime_type must be a media type, such as text/csv')

  const lookup: GoogleRequest = {
    method: 'GET', url: `${DRIVE_API}/files/${id}?${new URLSearchParams({ fields: 'id,name,mimeType,size,driveId', supportsAllDrives: 'true' }).toString()}`,
    what: 'GET file metadata', effect: 'read',
  }
  const meta = await googleJson(ctx, lookup)
  const where = fileDriveOf(meta)
  if (where.kind === 'malformed') throw unreadable(lookup, 'named the file\'s shared drive in a shape no drive id has')
  if (where.kind === 'shared' && !drives.includes(where.driveId)) throw driveNotDeclared(where.driveId, 'the file is in')

  const mimeType = typeof meta.mimeType === 'string' ? meta.mimeType : 'application/octet-stream'
  const isGoogleFile = mimeType.startsWith(GOOGLE_FILE)
  if (isGoogleFile && exportType === null) throw invalid('a Google Docs, Sheets or Slides file is downloaded as an export: name its export_mime_type')
  const declared = typeof meta.size === 'string' && /^\d+$/.test(meta.size) ? Number(meta.size) : null
  if (declared !== null && declared > DRIVE_DOWNLOAD_MAX_BYTES) throw fileTooLarge(declared)

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
