// GitHub Contents API — push workflow definitions as JSON files on every save (PRD 3.2)
// Requires GITHUB_TOKEN (secret) and GITHUB_REPO (var, e.g. "Try-Pennie/bidspoke-workflows")
// Silently no-ops if either is not configured — backup is best-effort.

const BRANCH = 'main'
const WORKFLOWS_DIR = 'workflows'

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

async function getCurrentFileSha(
  repo: string,
  filePath: string,
  token: string
): Promise<string | null> {
  const res = await fetch(apiUrl(repo, filePath), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub GET failed (${res.status})`)
  const data = await res.json() as GitHubFileResponse
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
  if (!token || !repo) return null  // not configured — silently skip

  const filePath = `${WORKFLOWS_DIR}/${workflowId}.json`
  const content = JSON.stringify({ id: workflowId, name: workflowName, definition }, null, 2)
  const contentBase64 = btoa(unescape(encodeURIComponent(content)))
  const commitMessage = message?.trim() || `chore: update workflow "${workflowName}" to v${versionNumber}`

  // Fetch existing file SHA (required for updates; null for new files)
  const existingSha = await getCurrentFileSha(repo, filePath, token)

  const body: Record<string, unknown> = {
    message: commitMessage,
    content: contentBase64,
    branch: BRANCH,
  }
  if (existingSha) body.sha = existingSha

  const res = await fetch(apiUrl(repo, filePath), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`GitHub push failed (${res.status}): ${errBody}`)
  }

  const data = await res.json() as GitHubPutResponse
  return data.commit.sha
}
