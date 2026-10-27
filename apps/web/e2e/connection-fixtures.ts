/**
 * Every Worker call the Connections page makes, answered from fixtures (#2611).
 *
 * The accessibility job scanned /connections against the production Worker as
 * the test organization, which holds one connection, so it saw a list of one
 * and never a problem notice, a dialog or the Google list. Here every request
 * to the Worker is answered from fixtures/connections/, which the Worker's
 * connections-fixtures-contract.test.ts holds to what the routes answer: the
 * list at the settled design's count, two connections' History, the Google
 * mailboxes and drives, the Slack alerts login's settings, and the answer to
 * removing Lead notes (ops not told, which opens the page's removal notice).
 * Nothing reaches production: a call with no answer here is unmatched, and the
 * spec fails on it (worker-fixtures.ts).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import type { ConnectionList } from '../src/lib/api'
import { ownEntry, routeWorkerAnswers, type Answer } from './worker-fixtures'

const DIR = path.join(__dirname, 'fixtures', 'connections')
const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(DIR, file), 'utf8')) as T

export interface ConnectionFixtures {
  list: ConnectionList
  /** GET /api/connections/:id/history by connection id. */
  history: Record<string, unknown>
  googleSubjects: unknown
  slackAlerts: unknown
  /** DELETE /api/connections/:id for the one connection the scan removes. */
  remove: { outcome: 'removed'; connection: { id: string; generation: number }; ops: { told: true } | { told: false; cause: string; message: string } }
}

export function loadConnectionFixtures(): ConnectionFixtures {
  return {
    list: read('list.json'),
    history: read('history.json'),
    googleSubjects: read('google-subjects.json'),
    slackAlerts: read('slack-alerts.json'),
    remove: read('remove.json'),
  }
}

/** The answer to one Worker request, or null when the fixtures hold none. Pure, so it is unit tested. */
export function answerConnectionsFor(method: string, url: string, fx: ConnectionFixtures): Answer | null {
  const p = new URL(url).pathname
  const ok = (body: unknown): Answer => ({ status: 200, body })
  let m: RegExpExecArray | null
  if (method === 'DELETE' && (m = /^\/api\/connections\/([^/]+)$/.exec(p))) {
    return decodeURIComponent(m[1]) === fx.remove.connection.id ? ok(fx.remove) : null
  }
  if (method !== 'GET') return null
  if (p === '/api/connections') return ok(fx.list)
  if (p === '/api/connections/google/subjects') return ok(fx.googleSubjects)
  if (p === '/api/integrations/slack') return ok(fx.slackAlerts)
  if ((m = /^\/api\/connections\/([^/]+)\/history$/.exec(p))) {
    const answer = ownEntry(fx.history, decodeURIComponent(m[1]))
    return answer ? ok(answer) : null
  }
  return null
}

/** Answer every Worker request the Connections page makes from the fixtures. Returns the requests that had no answer. */
export async function routeConnectionFixtures(page: Page, workerUrl: string): Promise<{ unmatched: string[]; fx: ConnectionFixtures }> {
  const fx = loadConnectionFixtures()
  const { unmatched } = await routeWorkerAnswers(page, workerUrl, (method, url) => answerConnectionsFor(method, url, fx))
  return { unmatched, fx }
}
