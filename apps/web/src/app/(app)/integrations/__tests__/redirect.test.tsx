/**
 * The Integrations page is retired (#2338, build PR 14, R2). Its alert
 * settings are on the Slack alerts login's panel on the Connections page, and
 * its HTTP Services presets are gone, so /integrations sends an old bookmark
 * or link to that panel: /connections?connection=slack-alerts, which opens the
 * Slack alerts login. The route stays, as a redirect behind the sign in gate
 * (the middleware runs before it), so an unauthenticated caller is still sent
 * to sign in, which the gate probe checks (e2e/auth-gate.probe.ts).
 */
import { describe, expect, it, vi } from 'vitest'
import { SLACK_ALERT_LOGIN_LINK } from '@bidspoke/service-catalogue/schema'

vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { to }) }),
}))

import { redirect } from 'next/navigation'
import IntegrationsRedirect from '../page'

describe('/integrations (#2338)', () => {
  it('redirects to the Slack alerts login on the Connections page, and draws nothing of its own', () => {
    expect(() => IntegrationsRedirect()).toThrow('NEXT_REDIRECT')
    expect(vi.mocked(redirect)).toHaveBeenCalledWith(SLACK_ALERT_LOGIN_LINK)
    expect(SLACK_ALERT_LOGIN_LINK).toBe('/connections?connection=slack-alerts')
  })
})
