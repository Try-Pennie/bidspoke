// GitHub Contents API — push workflow definitions as JSON files on every save (PRD 3.2)
// Requires GITHUB_TOKEN (secret) and GITHUB_REPO (var, e.g. "Try-Pennie/bidspoke-workflows")
// Silently no-ops if either is not configured — backup is best-effort.

import { formatErr } from './format-error'
import { parseJson } from './json'

const BRANCH = 'main'
const WORKFLOWS_DIR = 'workflows'
// GitHub's REST API requires a User-Agent on every request (#240).
const USER_AGENT = 'bidspoke-worker'
// Matches the disposable workflow names the Playwright E2E suite creates
// (apps/web/e2e/workflows.spec.ts: `E2E-${Date.now()}`). Local `wrangler dev`
// shares the real Supabase project and Slack connection with production but has
// no GITHUB_TOKEN in .dev.vars, so every local E2E save used to trip the
// "misconfigured" throw and, after two saves, the real org's backup-failure
// Slack alert. These workflows are test data — never worth a real commit or
// a real alert, so they're skipped entirely, same as "no repo configured".
const E2E_TEST_WORKFLOW_NAME = /^E2E-\d+$/

interface GitHubFileResponse {
  sha?: string
  content?: string
}

interface GitHubPutResponse {
  commit: { sha: string }
}

function apiUrl(repo: string, filePath: string): string {
  return `https://api.github.com/repos/${repo}/contents/${filePath}`
}

/**
 * The headers every GitHub REST call here sends. GitHub rejects a request with
 * no User-Agent (403 "Request forbidden by administrative rules"), and Workers'
 * fetch adds none, which is why backups silently 403'd (#240).
 */
function githubHeaders(token: string, accept = 'application/vnd.github+json'): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': USER_AGENT,
  }
}

export type GitHubFileRead = { ok: true; text: string } | { ok: false; reason: string }

/**
 * Reads one file of the repo as raw text (#1472). The raw media type returns the
 * bytes whatever the file's size, where the JSON shape stops carrying content at
 * one megabyte. A failure is returned by status and body rather than thrown or
 * emptied, because an empty read of a mirror would compare as an empty canvas
 * (L215).
 */
export async function fetchGitHubFileText(
  repo: string,
  filePath: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubFileRead> {
  let res: Response
  try {
    res = await fetchImpl(apiUrl(repo, filePath), { headers: githubHeaders(token, 'application/vnd.github.raw+json') })
  } catch (err) {
    return { ok: false, reason: `GitHub GET ${filePath} threw: ${formatErr(err)}` }
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) return { ok: false, reason: `GitHub GET ${filePath} failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ''}` }
  return { ok: true, text }
}

async function getCurrentFileSha(
  repo: string,
  filePath: string,
  token: string
): Promise<string | null> {
  const res = await fetch(apiUrl(repo, filePath), { headers: githubHeaders(token) })
  if (res.status === 404) return null
  if (!res.ok) {
    // Surface GitHub's explanation (mirrors the PUT path). A 403 can mean an
    // expired/invalid token, a fine-grained token missing Contents permission,
    // org SAML-SSO authorization, or rate limiting — the body says which, so the
    // backup-failure alert (#206) is actionable instead of a bare status code.
    const errBody = await res.text().catch(() => '')
    throw new Error(`GitHub GET failed (${res.status})${errBody ? `: ${errBody}` : ''}`)
  }
  const data = await parseJson<GitHubFileResponse>(res)
  return data.sha ?? null
}

export async function pushWorkflowToGitHub(
  token: string | undefined,
  repo: string | undefined,
  workflowId: string,
  workflowName: string,
  definition: unknown,
  versionNumber: number,
  message?: string
): Promise<string | null> {
  // No repo configured = backup intentionally disabled; stay silent.
  if (!repo) return null
  // E2E test workflow = disposable test data; stay silent regardless of token.
  if (E2E_TEST_WORKFLOW_NAME.test(workflowName)) return null
  // Repo IS configured but token is missing = misconfiguration, not a disable.
  // Throw so the caller's log + failure-alert path runs instead of silently
  // skipping — a silent skip here hid the backup outage for ~2 months (#240).
  if (!token) throw new Error('GitHub backup misconfigured: GITHUB_TOKEN is not set (GITHUB_REPO is configured)')

  const filePath = `${WORKFLOWS_DIR}/${workflowId}.json`
  const content = JSON.stringify({ id: workflowId, name: workflowName, definition }, null, 2)
  const contentBase64 = btoa(unescape(encodeURIComponent(content)))
  const commitMessage = message?.trim() || `chore: update workflow "${workflowName}" to v${versionNumber}`

  async function putWithSha(sha: string | null): Promise<Response> {
    const body: Record<string, unknown> = {
      message: commitMessage,
      content: contentBase64,
      branch: BRANCH,
    }
    if (sha) body.sha = sha
    return fetch(apiUrl(repo!, filePath), {
      method: 'PUT',
      headers: { ...githubHeaders(token!), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  // Fetch existing file SHA (required for updates; null for new files)
  let res = await putWithSha(await getCurrentFileSha(repo, filePath, token))

  // 409 means a concurrent save committed between our SHA read and this PUT, so
  // our SHA is now stale (TOCTOU). Re-fetch the current SHA and retry once so the
  // losing save still lands its commit and records commit_sha, instead of being
  // silently dropped (#111). Last write wins by wall-clock — fine for a mirror;
  // workflow_versions in Supabase is the source of truth.
  if (res.status === 409) {
    res = await putWithSha(await getCurrentFileSha(repo, filePath, token))
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`GitHub push failed (${res.status}): ${errBody}`)
  }

  const data = await parseJson<GitHubPutResponse>(res)
  return data.commit.sha
}
