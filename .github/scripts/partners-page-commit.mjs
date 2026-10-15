// Whether the signed in partners page serves the commit just deployed (#2132).
//
// A partners page opened before a Worker change that refuses its saves is told
// to reload (428 reload_required). That helps only once the page it reloads
// into is the new one, so after Deploy Pages this signs in as the e2e user,
// fetches /partners the way a person does (no cache busting: a busted URL would
// measure a path no person takes, the same reason the propagation sampler
// gives, L472), and reads the build stamp with pages-commit-from-html.sh.
//
// Outcomes, each with its own sentence (L11), all but the first exiting 1:
//   flipped        /partners serves this commit.
//   not-followed   it did not within BUDGET_SECONDS.
//   not-signed-in  sign in failed, or the gate redirected: it measured nothing.
//   unstamped      the page carries no commit stamp: it measured nothing.
//   and a missing E2E_PASSWORD is an error, never a skip.
//
// The clock, the sleep and the network are injected (followPartnersPage), so
// tests set time rather than waiting on it (L290, L524). Run with
// `node --experimental-strip-types`, so it can import the shared cookie builder
// from apps/web/e2e/session-cookies.ts with no build step.

import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { sessionCookieHeader } from '../../apps/web/e2e/session-cookies.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const GATE_HEADER = 'x-bidspoke-gate'
const NOT_FOLLOWED = 'Pages has not followed the Worker; open partners pages will refuse saves with a reload message until it does.'

/** The stamp in a page, through the one reader the drift check and the sampler use. */
export function readStamp(html) {
  return execFileSync('bash', [join(HERE, 'pages-commit-from-html.sh')], { input: html, encoding: 'utf8' }).trim()
}

/**
 * @param {{ siteUrl: string, expectedSha: string, budgetSeconds: number, intervalSeconds: number,
 *   signIn: () => Promise<string>, fetchPage: (url: string, cookie: string) => Promise<{ status: number, headers: { get(name: string): string | null }, text(): Promise<string> }>,
 *   now: () => number, sleep: (ms: number) => Promise<void>, readStamp?: (html: string) => string }} deps
 */
export async function followPartnersPage(deps) {
  const read = deps.readStamp ?? readStamp
  const url = `${deps.siteUrl.replace(/\/+$/, '')}/partners`
  const start = deps.now()
  const elapsed = () => Math.round((deps.now() - start) / 1000)

  let cookie
  try {
    cookie = await deps.signIn()
  } catch (e) {
    return { outcome: 'not-signed-in', seconds: elapsed(), message: `The check could not sign in, so it measured nothing (${e instanceof Error ? e.message : 'unknown error'}).` }
  }

  // Bounded by a look count as well as the clock, so a clock that does not move cannot spin it (L704).
  const maxLooks = Math.floor(deps.budgetSeconds / deps.intervalSeconds) + 1
  let last = 'unreachable'
  for (let look = 1; look <= maxLooks; look++) {
    try {
      const res = await deps.fetchPage(url, cookie)
      const gate = res.headers.get(GATE_HEADER)
      if ((gate && gate !== 'allow') || (res.status >= 300 && res.status < 400)) {
        return { outcome: 'not-signed-in', seconds: elapsed(), message: `The check could not sign in, so it measured nothing (the site answered ${res.status} with ${GATE_HEADER}: ${gate ?? 'none'}).` }
      }
      last = read(await res.text())
      if (last === deps.expectedSha) {
        return { outcome: 'flipped', seconds: elapsed(), message: `The partners page serves ${deps.expectedSha.slice(0, 7)}, ${elapsed()} s after Deploy Pages finished.` }
      }
    } catch (e) {
      last = 'unreachable'
      console.error(`partners-page-follows: look ${look} failed: ${e instanceof Error ? e.message : 'unknown error'}`)
    }
    if (look < maxLooks && elapsed() < deps.budgetSeconds) await deps.sleep(deps.intervalSeconds * 1000)
    else break
  }

  if (last === 'unstamped') {
    return { outcome: 'unstamped', seconds: elapsed(), message: 'The partners page carries no commit stamp, so whether it follows the Worker was not measured.' }
  }
  const shown = last === 'unreachable' ? 'was unreachable' : `still serves ${last.slice(0, 7)}`
  return { outcome: 'not-followed', seconds: elapsed(), message: `${NOT_FOLLOWED} After ${deps.budgetSeconds} s, /partners ${shown}, not ${deps.expectedSha.slice(0, 7)}.` }
}

/** Sign in as the e2e user through the auth API and answer the Cookie header a browser would send. */
async function signInWithPassword(supabaseUrl, anonKey, email, password) {
  const res = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || !body || typeof body.access_token !== 'string') {
    throw new Error(`the auth API answered ${res.status}${body && body.error_description ? `: ${body.error_description}` : ''}`)
  }
  if (typeof body.expires_at !== 'number' && typeof body.expires_in === 'number') body.expires_at = Math.floor(Date.now() / 1000) + body.expires_in
  return sessionCookieHeader(supabaseUrl, body)
}

async function main() {
  const env = process.env
  if (!env.E2E_PASSWORD) {
    console.error('partners-page-follows: E2E_PASSWORD is not set, so whether the partners page follows the Worker was not measured. This job runs only on pushes to main, where the secret is available, so a missing one is a configuration fault.')
    process.exit(1)
  }
  for (const name of ['SITE_URL', 'EXPECTED_SHA', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'E2E_EMAIL']) {
    if (!env[name]) {
      console.error(`partners-page-follows: ${name} is not set, so nothing was measured.`)
      process.exit(1)
    }
  }
  const result = await followPartnersPage({
    siteUrl: env.SITE_URL,
    expectedSha: env.EXPECTED_SHA,
    budgetSeconds: Number(env.BUDGET_SECONDS ?? '180'),
    intervalSeconds: Number(env.INTERVAL_SECONDS ?? '15'),
    signIn: () => signInWithPassword(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, env.E2E_EMAIL, env.E2E_PASSWORD),
    fetchPage: (url, cookie) => fetch(url, { headers: { Cookie: cookie }, redirect: 'manual' }),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  console.log(`partners-page-follows: outcome=${result.outcome} seconds=${result.seconds}`)
  const line = `partners-page-follows: ${result.message}`
  if (result.outcome === 'flipped') console.log(line)
  else console.error(line)
  if (env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n\n`)
  }
  process.exit(result.outcome === 'flipped' ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
