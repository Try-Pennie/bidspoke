/**
 * Where the Google actions stop and fail by name (#2337), each a list or a body
 * a step must not take whole into a Worker's memory, or a request Google limits.
 */

/** Rows one Sheets append sends: every row in one request, so they land whole or not at all. */
export const SHEETS_APPEND_MAX_ROWS = 10_000
/** The largest Sheets append body (Google recommends 2 MB a request). */
export const SHEETS_APPEND_MAX_BYTES = 2 * 1024 * 1024
/** The largest raw message gmail-send-email sends (Gmail's simple send takes 5 MB). */
export const GMAIL_MAX_RAW_BYTES = 5 * 1024 * 1024
/** Pages of 1,000 files drive-list-files reads before it fails by name. */
export const DRIVE_LIST_MAX_PAGES = 10
/** The largest file drive-download-file reads. */
export const DRIVE_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024
/** Pages of 250 events calendar-list-events reads before it fails by name. */
export const CALENDAR_LIST_MAX_PAGES = 10
