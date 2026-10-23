import { ActionFailure } from '../failure'
import { DRIVE_API, googleJson, googleTargetOf, optionalText, unreadable, type GoogleRequest } from '../google/call'
import { bindDriveQuery } from '../google/drive-query'
import { DRIVE_LIST_MAX_PAGES } from '../google/limits'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * google.drive-list-files, version 1 (#2337). Released: never edit it; a change
 * is version 2 (the fingerprint check refuses an edit).
 *
 * Drive files.list, as the report parser code steps call it to find the day's
 * file: every page of the query's matches (id, name, mimeType, size, the
 * created and modified times, parents), shared drives included. A step's
 * values reach the query only as `?` binds (google/drive-query.ts). A shared
 * drive named in `drive_id` must be one the connection declares, which the
 * organization's list allowed at save (F129); otherwise it is refused before
 * anything is sent. Past DRIVE_LIST_MAX_PAGES pages of 1,000 it fails by name
 * (`google_drive_list_page_cap`), never a prefix.
 */

const FIELDS = 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,parents)'

export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  const { drives } = googleTargetOf(ctx.target)
  const query = optionalText(args, 'query')
  const q = query === null ? null : bindDriveQuery(query, args.binds)
  const driveId = optionalText(args, 'drive_id')
  if (driveId !== null && !drives.includes(driveId.trim())) {
    throw new ActionFailure('google_drive_not_declared', 'the shared drive is not one the connection declares, so it is not read', 'not_applied')
  }
  const files: JsonValue[] = []
  let pageToken: string | null = null
  for (let page = 1; page <= DRIVE_LIST_MAX_PAGES; page++) {
    const params = new URLSearchParams({ fields: FIELDS, pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' })
    if (driveId !== null) {
      params.set('corpora', 'drive')
      params.set('driveId', driveId.trim())
    } else {
      params.set('corpora', 'allDrives')
    }
    if (q !== null) params.set('q', q)
    if (pageToken !== null) params.set('pageToken', pageToken)
    const request: GoogleRequest = { method: 'GET', url: `${DRIVE_API}/files?${params.toString()}`, what: `GET files page ${page}`, effect: 'read' }
    const answer = await googleJson(ctx, request)
    if (!Array.isArray(answer.files)) throw unreadable(request, 'held no files list')
    files.push(...(answer.files as readonly JsonValue[]))
    if (typeof answer.nextPageToken !== 'string' || answer.nextPageToken === '') return { files }
    pageToken = answer.nextPageToken
  }
  throw new ActionFailure('google_drive_list_page_cap', `the query matches more than ${DRIVE_LIST_MAX_PAGES} pages of files, so none is returned; narrow the query`, 'not_applied')
}
