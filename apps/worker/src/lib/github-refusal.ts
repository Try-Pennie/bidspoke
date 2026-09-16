/**
 * Which refusal GitHub gave, read from the response rather than its status alone (#1365).
 *
 * GitHub answers 403 for causes that need opposite responses. An exhausted
 * request allowance is counted per ACCOUNT, so any other use of the account that
 * owns the credential spends it, and it clears on its own. A missing permission
 * needs a person to change the credential. On 2026-09-16 the scheduled workflow
 * checks reduced both to "GitHub returned 403" and told the reader to replace a
 * credential that had dispatched a workflow an hour earlier, which is a message
 * claiming more than its check measured (L11).
 *
 * Shared by the schedule watch and the dispatch driver so the two cannot read the
 * same response differently.
 */

export type GithubRefusal = {
  kind: 'rate_limited' | 'refused'
  status: number
  /** When a rate limit lifts, if GitHub said. Always null for a refusal. */
  resetsAtIso: string | null
  /** The `message` from GitHub's JSON body, or null when there was none. */
  message: string | null
}

const RATE_LIMIT_MESSAGE = /rate limit/i

async function readMessage(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json()
    if (body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string') {
      return (body as { message: string }).message
    }
  } catch {
    // A body that is not JSON carries no message to quote. The status still
    // stands as the reading, so nothing is lost by returning null here.
  }
  return null
}

function resetTime(response: Response, nowMs: number): string | null {
  const reset = Number(response.headers.get('x-ratelimit-reset'))
  if (response.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && reset > 0) {
    return new Date(reset * 1000).toISOString()
  }
  const retryAfter = response.headers.get('retry-after')
  const seconds = retryAfter === null ? NaN : Number(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0) return new Date(nowMs + seconds * 1000).toISOString()
  return null
}

/** Read a non success GitHub response. Consumes the body. */
export async function readGithubRefusal(response: Response, nowMs: number = Date.now()): Promise<GithubRefusal> {
  const message = await readMessage(response)
  const limited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' ||
        response.headers.get('retry-after') !== null ||
        (message !== null && RATE_LIMIT_MESSAGE.test(message))))
  return {
    kind: limited ? 'rate_limited' : 'refused',
    status: response.status,
    resetsAtIso: limited ? resetTime(response, nowMs) : null,
    message,
  }
}

const easternTime = (iso: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso))

/** One clause for a reason string, saying what GitHub said and nothing more. */
export function describeGithubRefusal(refusal: GithubRefusal): string {
  if (refusal.kind === 'rate_limited') {
    const when = refusal.resetsAtIso === null ? '' : `, and resets at ${easternTime(refusal.resetsAtIso)}`
    return `GitHub's API rate limit for the account that owns the credential is used up (${refusal.status})${when}. This clears on its own`
  }
  const said = refusal.message === null ? '' : `: "${refusal.message}"`
  return `GitHub returned ${refusal.status}${said}`
}

/** The repair for a rate limit, named once for every alert that can carry one. */
export const GITHUB_RATE_LIMIT_FIX =
  'A rate limit needs no change and clears on its own. GitHub counts requests per account, so anything else using the account that owns `GITHUB_ACTIONS_TOKEN` (the gh CLI, scripts, other tools) spends the same hourly allowance, and the next check reads again once it resets. If this keeps happening, give the worker a token owned by an account nothing else uses.'
