// .github/scripts/ops-connections-probe.mjs: after deploy, a real call through
// the bidding Worker's OPS_CONNECTIONS binding (#2335, PR 9 of phase 5 of #1689).
//
// The Phase 0 spike (#2330) measured that Cloudflare deploys a binding to an
// entrypoint the deployed ops Worker does not export green, and every call then
// throws "internal error; reference = <id>". So Deploy signs in as the e2e user
// and asks the DEPLOYED bidding Worker's GET /api/admin/ops-connections-probe,
// which sends OpsConnections.health a request ops refuses by name before reading
// anything (it touches nobody's data), and fails the run unless that is answered.
//
// Outcomes, each with its own sentence (L11), all but the first exiting 1:
//   answered        the binding resolved and ops answered the expected refusal.
//   unexpected      ops answered something else (its config): fails at once.
//   not-signed-in   sign in failed, or the route refused the session: measured nothing.
//   unavailable     the binding threw, was absent or did not answer, to the end of the budget.
//   route-missing   the old version, without the probe route, answered to the end.
//   unreachable     every ask failed on the network.
//   and a missing E2E_PASSWORD is an error, never a skip.
//
// A new version reaches every edge over a few seconds, so everything but the
// first three outcomes is asked again, INTERVAL_SECONDS apart, within
// BUDGET_SECONDS, bounded by a count of asks as well as the clock (L704). The
// clock, the sleep and the network are injected (L290, L524).

import { pathToFileURL } from 'node:url'
import { passwordSession } from './e2e-session.mjs'

export const PROBE_PATH = '/api/admin/ops-connections-probe'
const EXPECTED = 'ops_connections_request_invalid'

const describeUnavailable = (body) => {
  const cause = typeof body?.cause === 'string' ? body.cause : 'an unnamed cause'
  const reference = typeof body?.reference === 'string' ? `, reference ${body.reference}` : ''
  return `ops_connections_unavailable (${cause}${reference})`
}

/**
 * @param {{ workerUrl: string, budgetSeconds: number, intervalSeconds: number, signIn: () => Promise<string>,
 *   fetchProbe: (url: string, token: string) => Promise<{ status: number, body: unknown }>,
 *   now: () => number, sleep: (ms: number) => Promise<void> }} deps
 */
export async function probeAfterDeploy(deps) {
  const url = `${deps.workerUrl.replace(/\/+$/, '')}${PROBE_PATH}`
  const start = deps.now()
  const elapsed = () => Math.round((deps.now() - start) / 1000)

  let token
  try {
    token = await deps.signIn()
  } catch (e) {
    return { outcome: 'not-signed-in', message: `The probe could not sign in, so it measured nothing (${e instanceof Error ? e.message : 'unknown error'}).` }
  }

  const maxAsks = Math.floor(deps.budgetSeconds / deps.intervalSeconds) + 1
  let last = { outcome: 'unreachable', seen: 'no answer' }
  for (let ask = 1; ask <= maxAsks; ask++) {
    try {
      const { status, body } = await deps.fetchProbe(url, token)
      if (status === 200 && body?.ok === true && body?.answer === EXPECTED) {
        return { outcome: 'answered', message: `OPS_CONNECTIONS answered through the deployed bidding Worker: health refused the probe request by name (${EXPECTED}), ${elapsed()} s after the deploy.` }
      }
      if (status === 401 || status === 403) {
        return { outcome: 'not-signed-in', message: `${url} refused the e2e session with ${status}, so the probe measured nothing.` }
      }
      if (status === 502 || status === 200) {
        const answer = typeof body?.answer === 'string' ? body.answer : JSON.stringify(body)
        return { outcome: 'unexpected', message: `OpsConnections answered ${answer} through the binding, not ${EXPECTED}: the ops Worker is answering but not as its probe request earns (its LANE or its contract).` }
      }
      if (status === 503) last = { outcome: 'unavailable', seen: describeUnavailable(body) }
      else if (status === 404) last = { outcome: 'route-missing', seen: '404, the version without the probe route' }
      else last = { outcome: 'unreachable', seen: `${status}` }
      console.error(`ops-connections-probe: ask ${ask} answered ${last.seen}`)
    } catch (e) {
      last = { outcome: 'unreachable', seen: e instanceof Error ? e.message : 'a network error' }
      console.error(`ops-connections-probe: ask ${ask} failed: ${last.seen}`)
    }
    if (ask < maxAsks && elapsed() < deps.budgetSeconds) await deps.sleep(deps.intervalSeconds * 1000)
    else break
  }

  const messages = {
    unavailable: `The call through OPS_CONNECTIONS did not answer within ${deps.budgetSeconds} s: last ${last.seen}. A throw names no cause, so this does not say whether the ops Worker is running; check that the deployed bidspoke-worker-ops exports OpsConnections (ops-exports-entrypoint.mjs).`,
    'route-missing': `${url} answered 404 for ${deps.budgetSeconds} s: the deployed bidding Worker is not the version with the probe route.`,
    unreachable: `${url} gave no answer for ${deps.budgetSeconds} s: last ${last.seen}.`,
  }
  return { outcome: last.outcome, message: messages[last.outcome] }
}

async function main() {
  const env = process.env
  if (!env.E2E_PASSWORD) {
    console.error('::error::ops-connections-probe: E2E_PASSWORD is not set, so the call through OPS_CONNECTIONS was not made. This job runs only on deploys, where the secret is available, so a missing one is a configuration fault.')
    process.exit(1)
  }
  for (const name of ['WORKER_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'E2E_EMAIL']) {
    if (!env[name]) {
      console.error(`::error::ops-connections-probe: ${name} is not set, so nothing was measured.`)
      process.exit(1)
    }
  }
  const result = await probeAfterDeploy({
    workerUrl: env.WORKER_URL,
    budgetSeconds: Number(env.BUDGET_SECONDS ?? '120'),
    intervalSeconds: Number(env.INTERVAL_SECONDS ?? '10'),
    signIn: async () => (await passwordSession(fetch, env.SUPABASE_URL, env.SUPABASE_ANON_KEY, env.E2E_EMAIL, env.E2E_PASSWORD)).access_token,
    fetchProbe: async (url, token) => {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) })
      return { status: res.status, body: await res.json().catch(() => null) }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  const line = `ops-connections-probe: ${result.message}`
  if (result.outcome === 'answered') console.log(line)
  else console.error(`::error::${line}`)
  if (env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n\n`)
  }
  process.exit(result.outcome === 'answered' ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
