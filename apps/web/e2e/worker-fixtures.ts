/**
 * The one way a page under the accessibility scan has its Worker calls answered
 * from fixtures (#2134, #2611): every request to the Worker's API goes to the
 * page's own answer function, nothing is forwarded, and a call with no answer is
 * recorded as unmatched and answered 599, so the spec, which asserts the list is
 * empty, fails on any Worker route its fixtures do not cover.
 */
import type { Page } from '@playwright/test'

export interface Answer { status: number; body: unknown }

/** The answer to one Worker request, or null when the fixtures hold none. */
export type AnswerOf = (method: string, url: string) => Answer | null

/**
 * A request the fixtures answer: one to the Worker's API. Only `/api/` paths are
 * taken, so if the Worker were ever served from the web app's own origin the
 * page's own documents and scripts would still load.
 */
export function isWorkerApiRequest(url: URL, workerOrigin: string): boolean {
  return url.origin === new URL(workerOrigin).origin && url.pathname.startsWith('/api/')
}

/**
 * A fixture's own entry for an id, or undefined. A JSON object's inherited
 * names (constructor, toString) are no entry, and nor is a file's own note key
 * (one starting with _), so a page asking for one gets no answer.
 */
export function ownEntry<T>(record: Record<string, T>, id: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, id) && !id.startsWith('_') ? record[id] : undefined
}

/** Answer every request to the Worker from `answerOf`. Returns the requests that had no answer; the caller asserts it is empty. */
export async function routeWorkerAnswers(page: Page, workerUrl: string, answerOf: AnswerOf): Promise<{ unmatched: string[] }> {
  const unmatched: string[] = []
  await page.route((url) => isWorkerApiRequest(url, workerUrl), async (route) => {
    const req = route.request()
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const answer = answerOf(req.method(), req.url())
    if (!answer) {
      unmatched.push(`${req.method()} ${new URL(req.url()).pathname}`)
      return route.fulfill({ status: 599, headers: cors, contentType: 'application/json', body: JSON.stringify({ error: 'no_fixture' }) })
    }
    return route.fulfill({ status: answer.status, headers: cors, contentType: 'application/json', body: JSON.stringify(answer.body) })
  })
  return { unmatched }
}
