import { redirect } from 'next/navigation'
import { SLACK_ALERT_LOGIN_LINK } from '@bidspoke/service-catalogue/schema'

export const runtime = 'edge'

/**
 * The Integrations page is retired (#2338, build PR 14, R2): the channel the
 * alerts post to and the four alert switches are on the Slack alerts login's
 * panel on the Connections page, its token is saved there by Reconnect, and
 * HTTP Services presets are gone. An old bookmark or link lands on that panel.
 * The sign in gate (middleware.ts) runs before this, so a caller with no
 * session is sent to sign in, as before.
 */
export default function IntegrationsRedirect(): never {
  redirect(SLACK_ALERT_LOGIN_LINK)
}
