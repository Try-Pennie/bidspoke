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

/**
 * The Slack alert login as the Connections page lists it (D2): the bot that
 * posts Bidspoke's own alerts, stored as the row named `slack`, shown by this
 * name under Slack, whose name comes from the catalogue's Slack entry (#2337).
 */
export const SLACK_ALERT_LOGIN_NAME = 'Bidspoke Alerts'

/**
 * The Connections page with the Slack alerts login open (#2338, build PR 14):
 * where its token is reconnected and its alerts are set. The value names the
 * login itself, not its row's id, so a link written without reading the
 * database (an alert's text, the /integrations redirect) still opens it; the
 * page reads it as the organization's Slack alerts login.
 */
export const SLACK_ALERT_LOGIN_LINK_ID = 'slack-alerts'
export const SLACK_ALERT_LOGIN_LINK = `/connections?connection=${SLACK_ALERT_LOGIN_LINK_ID}`

/** A status the Needs attention group holds: every one but Working. */
export function isConnectionProblem(status: ConnectionPageStatus): boolean {
  return status !== 'ok'
}
