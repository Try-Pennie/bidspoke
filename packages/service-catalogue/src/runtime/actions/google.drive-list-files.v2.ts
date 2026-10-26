import { ActionFailure } from '../failure'
import { DRIVE_API, googleJson, googleTargetOf, isObject, optionalText, unreadable, type GoogleRequest } from '../google/call'
import { driveNotDeclared, fileDriveOf } from '../google/drive'
import { bindDriveQuery } from '../google/drive-query'
import { DRIVE_LIST_MAX_PAGES } from '../google/limits'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * google.drive-list-files, version 2 (#2805). Released: never edit it; a change
 * is version 3 (the fingerprint check refuses an edit).
 *
 * Version 1 listed every drive the mailbox can reach when no drive was named
 * (corpora=allDrives). This version holds the connection's own drive list
 * (Dan's decision of 2026-10-26): with no drive named it searches the
 * mailbox's own files (corpora=user, shared drive items left out), then each
 * drive the connection declares (corpora=drive), in the declared order, and
 * never all drives. A drive named in `drive_id` must be a declared one, or it
 * is refused by name before anything is sent. A file Drive answers as being in
 * a shared drive the connection does not declare is never returned, whichever
 * search answered it.
 *
 * Every page of every search counts against one DRIVE_LIST_MAX_PAGES, so a
 * connection declaring many drives reads no more than one search could; past
 * it the action fails by name (`google_drive_list_page_cap`), never a prefix.
 * A refusal on any search (a 403, a 429) fails the whole list, not applied.
 * Each file is { id, name, mimeType, size, createdTime, modifiedTime, parents,
 * driveId }, driveId only for a file in a shared drive.
 */

const FIELDS = 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,parents,driveId)'

/** One search: the mailbox's own files, or one declared drive. */
type Corpus = { readonly kind: 'user' } | { readonly kind: 'drive'; readonly driveId: string }

export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  const { drives } = googleTargetOf(ctx.target)
  const query = optionalText(args, 'query')
  const q = query === null ? null : bindDriveQuery(query, args.binds)
  const named = optionalText(args, 'drive_id')
  const driveId = named === null ? null : named.trim()
  if (driveId !== null && !drives.includes(driveId)) throw driveNotDeclared(driveId, 'drive_id names')

  const corpora: Corpus[] = driveId !== null
    ? [{ kind: 'drive', driveId }]
    : [{ kind: 'user' }, ...[...new Set(drives)].map((d): Corpus => ({ kind: 'drive', driveId: d }))]

  const files: JsonValue[] = []
  const seen = new Set<string>()
  let pages = 0
  for (const corpus of corpora) {
    let pageToken: string | null = null
    for (;;) {
      if (pages >= DRIVE_LIST_MAX_PAGES) {
        throw new ActionFailure('google_drive_list_page_cap', `the query matches more than ${DRIVE_LIST_MAX_PAGES} pages of files across the mailbox and its declared drives, so none is returned; narrow the query or name a drive`, 'not_applied')
      }
      pages++
      const params = new URLSearchParams({ fields: FIELDS, pageSize: '1000', supportsAllDrives: 'true' })
      if (corpus.kind === 'user') {
        params.set('corpora', 'user')
        params.set('includeItemsFromAllDrives', 'false')
      } else {
        params.set('corpora', 'drive')
        params.set('driveId', corpus.driveId)
        params.set('includeItemsFromAllDrives', 'true')
      }
      if (q !== null) params.set('q', q)
      if (pageToken !== null) params.set('pageToken', pageToken)
      const where = corpus.kind === 'user' ? 'the mailbox\'s files' : 'a declared drive'
      const request: GoogleRequest = { method: 'GET', url: `${DRIVE_API}/files?${params.toString()}`, what: `GET files of ${where}, page ${pages}`, effect: 'read' }
      const answer = await googleJson(ctx, request)
      if (!Array.isArray(answer.files)) throw unreadable(request, 'held no files list')
      for (const file of answer.files as readonly JsonValue[]) {
        if (!isObject(file)) throw unreadable(request, 'held a file that is not an object')
        const where = fileDriveOf(file)
        // Never a file of a drive the connection does not declare, nor one whose drive cannot be read.
        if (where.kind === 'malformed' || (where.kind === 'shared' && !drives.includes(where.driveId))) continue
        const id = typeof file.id === 'string' ? file.id : null
        if (id !== null) {
          if (seen.has(id)) continue
          seen.add(id)
        }
        files.push(file)
      }
      if (typeof answer.nextPageToken !== 'string' || answer.nextPageToken === '') break
      pageToken = answer.nextPageToken
    }
  }
  return { files }
}
