/**
 * The Connections page's one status vocabulary (#2338, R3, D3): every status a
 * connection shows, and its word. The list route answers these keys and words,
 * and the Connections page and the step form's Connection field (R8) read the
 * same list, so a status reads alike wherever it appears (L605).
 * connection-status.test.ts holds it to the settled design's statusVocabulary
 * (docs/design/connections-page.fixture.json).
 *
 * How ops's five statuses fold into these three is the bidding Worker's
 * (apps/worker/src/lib/connection-statuses.ts), where ops's list is.
 */
export const CONNECTION_PAGE_STATUSES = ['ok', 'reauth', 'failing'] as const
export type ConnectionPageStatus = (typeof CONNECTION_PAGE_STATUSES)[number]

export const CONNECTION_STATUS_WORDS: Readonly<Record<ConnectionPageStatus, string>> = {
  ok: 'Working',
  reauth: 'Needs reconnecting',
  failing: 'Check failing',
}

/** A status the Needs attention group holds: every one but Working. */
export function isConnectionProblem(status: ConnectionPageStatus): boolean {
  return status !== 'ok'
}
