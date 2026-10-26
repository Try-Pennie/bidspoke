import { ActionFailure } from '../failure'
import type { JsonValue } from '../types'
import { DRIVE_DOWNLOAD_MAX_BYTES } from './limits'

/**
 * What the Drive actions from version 2 on share (#2805): a connection's
 * declared drive list, held in the action, and a download's capped read.
 *
 * Version 1 of drive-download-file keeps its own copy of the read, since a
 * released action's source is never edited (its fingerprint covers every file
 * it reaches); every later version reads through here.
 */

/** A shared drive id as Drive issues one (the shape the ops list's own CHECK holds). */
const DRIVE_ID = /^[A-Za-z0-9_-]{10,128}$/

export function driveNotDeclared(driveId: string, what: string): ActionFailure {
  return new ActionFailure('google_drive_not_declared', `${what} the shared drive ${driveId}, which the connection does not declare, so it is not read`, 'not_applied')
}

/** Where a Drive answer says a file is. */
export type FileDrive =
  /** In no shared drive: a My Drive, the mailbox's own or one shared with it, which Drive's own sharing bounds. */
  | { readonly kind: 'none' }
  | { readonly kind: 'shared'; readonly driveId: string }
  /** A driveId no drive id has, which no caller may read as "in no shared drive". */
  | { readonly kind: 'malformed' }

export function fileDriveOf(file: Readonly<Record<string, JsonValue>>): FileDrive {
  if (!Object.hasOwn(file, 'driveId') || file.driveId === null || file.driveId === undefined) return { kind: 'none' }
  return typeof file.driveId === 'string' && DRIVE_ID.test(file.driveId) ? { kind: 'shared', driveId: file.driveId } : { kind: 'malformed' }
}

export function fileTooLarge(bytes: number): ActionFailure {
  return new ActionFailure('google_drive_file_too_large', `the file is ${bytes} bytes, over the ${DRIVE_DOWNLOAD_MAX_BYTES} a step reads`, 'not_applied')
}

export function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** The body, read until it passes the cap and no further, so an export Drive gave no size for cannot fill the Worker. */
export async function readCapped(response: Response): Promise<Uint8Array> {
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
      throw fileTooLarge(total)
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
