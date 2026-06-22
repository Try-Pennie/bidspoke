// Cloudflare Workers Secrets API — used to sync env var secrets (PRD Section 12.3)
// Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID secrets on the Worker

import { parseJson } from './json'

const WORKER_NAME = 'bidspoke-worker'

// List the names of the worker's Cloudflare secrets (names only — the API never
// returns secret values). Used by the secret-drift check to compare against the
// secrets the database expects (#199). Returns null when CF isn't configured
// (dev) so callers can skip rather than treat it as "no secrets exist".
export async function listCfSecretNames(
  accountId: string | undefined,
  apiToken: string | undefined
): Promise<Set<string> | null> {
  if (!accountId || !apiToken) {
    console.warn('[dev] Skipping CF secret list — CLOUDFLARE_ACCOUNT_ID/API_TOKEN not configured')
    return null
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${WORKER_NAME}/secrets`,
    { method: 'GET', headers: { Authorization: `Bearer ${apiToken}` } }
  )
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Failed to list Cloudflare secrets (${res.status}): ${body}`)
  }
  const data = await parseJson<{ result?: { name: string }[] | null }>(res)
  return new Set((data.result ?? []).map((s) => s.name))
}

export async function setCfSecret(
  key: string,
  value: string,
  accountId: string | undefined,
  apiToken: string | undefined
): Promise<void> {
  if (!accountId || !apiToken) {
    console.warn(`[dev] Skipping CF secret sync for "${key}" — CLOUDFLARE_ACCOUNT_ID/API_TOKEN not configured`)
    return
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${WORKER_NAME}/secrets`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: key, text: value, type: 'secret_text' }),
    }
  )
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Failed to set Cloudflare secret: ${body}`)
  }
}

export async function deleteCfSecret(
  key: string,
  accountId: string | undefined,
  apiToken: string | undefined
): Promise<void> {
  if (!accountId || !apiToken) {
    console.warn(`[dev] Skipping CF secret delete for "${key}" — CLOUDFLARE_ACCOUNT_ID/API_TOKEN not configured`)
    return
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${WORKER_NAME}/secrets/${key}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiToken}` },
    }
  )
  if (!res.ok && res.status !== 404) {
    const body = await res.text()
    throw new Error(`Failed to delete Cloudflare secret: ${body}`)
  }
}
