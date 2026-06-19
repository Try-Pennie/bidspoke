/**
 * GitHub backup utility — PRD Section 3.2
 * Covers: pushes definition as base64 JSON, uses existing file SHA on update,
 * returns null when not configured, throws on API failure.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { pushWorkflowToGitHub } from '../github'

const TOKEN = 'ghp_test'
const REPO = 'org/workflows'
const WF_ID = 'wf-123'
const WF_NAME = 'Test Workflow'
const DEFINITION = { nodes: [], edges: [] }
const VERSION = 3

function makeResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('pushWorkflowToGitHub', () => {
  it('throws when a backup repo is configured but the token is missing, so the skip is not silent (#240)', async () => {
    // A configured repo + missing token is a misconfiguration, not an intentional
    // disable. Throwing routes it through the caller's log + failure-alert path
    // instead of silently no-op'ing (the gap that hid the outage for ~2 months).
    await expect(
      pushWorkflowToGitHub(undefined, REPO, WF_ID, WF_NAME, DEFINITION, VERSION)
    ).rejects.toThrow(/GITHUB_TOKEN/)
  })

  it('returns null (intentional, silent) when no backup repo is configured', async () => {
    expect(await pushWorkflowToGitHub(TOKEN, undefined, WF_ID, WF_NAME, DEFINITION, VERSION)).toBeNull()
    // No repo at all = backup disabled, regardless of token — stays quiet.
    expect(await pushWorkflowToGitHub(undefined, undefined, WF_ID, WF_NAME, DEFINITION, VERSION)).toBeNull()
  })

  it('creates a new file when none exists (no existing SHA)', async () => {
    const commitSha = 'abc123'
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeResponse({}, 404))          // GET — file not found
      .mockResolvedValueOnce(makeResponse({ commit: { sha: commitSha } }, 201))  // PUT — create
    vi.stubGlobal('fetch', mockFetch)

    const result = await pushWorkflowToGitHub(TOKEN, REPO, WF_ID, WF_NAME, DEFINITION, VERSION)
    expect(result).toBe(commitSha)

    const [, putInit] = mockFetch.mock.calls[1] as [string, RequestInit]
    const putBody = JSON.parse(putInit.body as string) as Record<string, unknown>
    expect(putBody.sha).toBeUndefined()  // no sha on create
    expect(putBody.branch).toBe('main')
    expect(typeof putBody.content).toBe('string')  // base64
  })

  it('includes existing file SHA when updating', async () => {
    const existingSha = 'existing-sha-456'
    const commitSha = 'new-sha-789'
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeResponse({ sha: existingSha }))  // GET — file exists
      .mockResolvedValueOnce(makeResponse({ commit: { sha: commitSha } }))  // PUT — update
    vi.stubGlobal('fetch', mockFetch)

    const result = await pushWorkflowToGitHub(TOKEN, REPO, WF_ID, WF_NAME, DEFINITION, VERSION)
    expect(result).toBe(commitSha)

    const [, putInit] = mockFetch.mock.calls[1] as [string, RequestInit]
    const putBody = JSON.parse(putInit.body as string) as Record<string, unknown>
    expect(putBody.sha).toBe(existingSha)
  })

  it('uses the workflow name and version in the commit message', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeResponse({}, 404))
      .mockResolvedValueOnce(makeResponse({ commit: { sha: 'sha' } }))
    vi.stubGlobal('fetch', mockFetch)

    await pushWorkflowToGitHub(TOKEN, REPO, WF_ID, WF_NAME, DEFINITION, VERSION)

    const [, putInit] = mockFetch.mock.calls[1] as [string, RequestInit]
    const putBody = JSON.parse(putInit.body as string) as Record<string, unknown>
    expect(putBody.message as string).toContain(WF_NAME)
    expect(putBody.message as string).toContain(String(VERSION))
  })

  it('uses a custom message when provided', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeResponse({}, 404))
      .mockResolvedValueOnce(makeResponse({ commit: { sha: 'sha' } }))
    vi.stubGlobal('fetch', mockFetch)

    await pushWorkflowToGitHub(TOKEN, REPO, WF_ID, WF_NAME, DEFINITION, VERSION, 'fix: bad filter logic')

    const [, putInit] = mockFetch.mock.calls[1] as [string, RequestInit]
    const putBody = JSON.parse(putInit.body as string) as Record<string, unknown>
    expect(putBody.message).toBe('fix: bad filter logic')
  })

  it('writes the file to workflows/{workflowId}.json', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeResponse({}, 404))
      .mockResolvedValueOnce(makeResponse({ commit: { sha: 'sha' } }))
    vi.stubGlobal('fetch', mockFetch)

    await pushWorkflowToGitHub(TOKEN, REPO, WF_ID, WF_NAME, DEFINITION, VERSION)

    const [getUrl] = mockFetch.mock.calls[0] as [string]
    const [putUrl] = mockFetch.mock.calls[1] as [string]
    expect(getUrl).toContain(`workflows/${WF_ID}.json`)
    expect(putUrl).toContain(`workflows/${WF_ID}.json`)
  })

  it('retries once on 409 (stale SHA from a concurrent save) and lands the commit (#111)', async () => {
    const staleSha = 'sha-A'
    const freshSha = 'sha-B'
    const commitSha = 'commit-after-retry'
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeResponse({ sha: staleSha }))                 // GET — first SHA read
      .mockResolvedValueOnce(makeResponse({ message: 'conflict' }, 409))      // PUT — loses the race
      .mockResolvedValueOnce(makeResponse({ sha: freshSha }))                 // GET — re-read SHA
      .mockResolvedValueOnce(makeResponse({ commit: { sha: commitSha } }))    // PUT — retry succeeds
    vi.stubGlobal('fetch', mockFetch)

    const result = await pushWorkflowToGitHub(TOKEN, REPO, WF_ID, WF_NAME, DEFINITION, VERSION)
    expect(result).toBe(commitSha)
    expect(mockFetch).toHaveBeenCalledTimes(4)

    // The retry PUT must carry the freshly re-fetched SHA, not the stale one.
    const [, retryInit] = mockFetch.mock.calls[3] as [string, RequestInit]
    const retryBody = JSON.parse(retryInit.body as string) as Record<string, unknown>
    expect(retryBody.sha).toBe(freshSha)
  })

  it('throws if the 409 retry also fails (does not loop forever) (#111)', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeResponse({ sha: 'sha-A' }))               // GET
      .mockResolvedValueOnce(makeResponse({ message: 'conflict' }, 409))   // PUT — 409
      .mockResolvedValueOnce(makeResponse({ sha: 'sha-B' }))               // GET — re-read
      .mockResolvedValueOnce(makeResponse({ message: 'conflict' }, 409))   // PUT — still 409
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      pushWorkflowToGitHub(TOKEN, REPO, WF_ID, WF_NAME, DEFINITION, VERSION)
    ).rejects.toThrow('GitHub push failed (409)')
    expect(mockFetch).toHaveBeenCalledTimes(4)  // no third PUT attempt
  })

  it('sends a User-Agent header on both requests (GitHub returns 403 without one) (#240)', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeResponse({}, 404))                     // GET
      .mockResolvedValueOnce(makeResponse({ commit: { sha: 'sha' } }))  // PUT
    vi.stubGlobal('fetch', mockFetch)

    await pushWorkflowToGitHub(TOKEN, REPO, WF_ID, WF_NAME, DEFINITION, VERSION)

    const [, getInit] = mockFetch.mock.calls[0] as [string, RequestInit]
    const [, putInit] = mockFetch.mock.calls[1] as [string, RequestInit]
    const getHeaders = getInit.headers as Record<string, string>
    const putHeaders = putInit.headers as Record<string, string>
    expect(getHeaders['User-Agent']).toBeTruthy()
    expect(putHeaders['User-Agent']).toBeTruthy()
  })

  it('includes the GitHub response body when the GET fails, so the alert shows the cause (#206)', async () => {
    const reason = 'Resource protected by organization SAML enforcement. You must grant your token access to this organization.'
    const mockFetch = vi.fn().mockResolvedValueOnce(makeResponse({ message: reason }, 403))
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      pushWorkflowToGitHub(TOKEN, REPO, WF_ID, WF_NAME, DEFINITION, VERSION)
    ).rejects.toThrow(/GitHub GET failed \(403\)[\s\S]*SAML enforcement/)
  })

  it('throws when the PUT request fails', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeResponse({}, 404))
      .mockResolvedValueOnce(makeResponse({ message: 'Bad credentials' }, 401))
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      pushWorkflowToGitHub(TOKEN, REPO, WF_ID, WF_NAME, DEFINITION, VERSION)
    ).rejects.toThrow('GitHub push failed (401)')
  })
})
