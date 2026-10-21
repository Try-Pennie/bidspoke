// .github/scripts/ops-exports-entrypoint.mjs: does the DEPLOYED ops Worker
// export the OpsConnections entrypoint the bidding Worker binds? (#2335, PR 9 of
// phase 5 of #1689)
//
//   CLOUDFLARE_API_TOKEN=... node .github/scripts/ops-exports-entrypoint.mjs
//
// The bidding Worker's OPS_CONNECTIONS binding (apps/worker/wrangler.toml) names
// the entrypoint OpsConnections of bidspoke-worker-ops. The Phase 0 spike (#2330)
// measured that Cloudflare deploys a binding to an entrypoint the deployed Worker
// does not export green, and every call then throws "internal error; reference =
// <id>". The repo cannot answer whether the LIVE ops Worker exports it, so this
// reads the live script: the latest deployment (refused when split across
// versions, since the content read cannot say which version it is), then the
// script content, and passes only when its main module exports OpsConnections
// as a class extending WorkerEntrypoint with every method bidding calls.
//
// CI runs it only on a pull request that changes the binding, the ops Worker or
// this script (bindingCheckDecision), so a change that would bind a missing
// entrypoint cannot merge on a green check. A money hotfix is never held up by
// the state of the ops Worker or a Cloudflare API failure (Hard Rule 1):
// wrangler.toml, which carries the money Worker's own vars and bindings, counts
// only when its patch changes a line naming OPS_CONNECTIONS or the ops Worker,
// and a pull request whose files cannot be read is skipped with a warning.
// Bidding wins those cases because nothing is lost: after deploy, Deploy calls
// through the binding itself (ops-connections-probe.mjs), and a missing
// entrypoint can never reach the money path. Once measured, any API failure
// fails (L98).

import { readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accountIdFrom } from './worker-secret-parity.mjs'

export const OPS = 'bidspoke-worker-ops'
export const ENTRYPOINT = 'OpsConnections'
/** OPS_CONNECTIONS_METHODS in apps/worker/src/lib/ops-connections-contract.ts; a test holds the two equal. */
export const METHODS = ['verify', 'clearReauth', 'revoke', 'health', 'lookup', 'exchangeOAuthCode', 'addDelegationSubject', 'removeDelegationSubject', 'listDelegationSubjects']

const API = 'https://api.cloudflare.com/client/v4'

/** The pull request files that can change whether the binding resolves, whatever their patch. */
const BINDING_SURFACE = [
  /^apps\/worker\/wrangler\.ops\.toml$/,
  /^apps\/worker\/src\/ops\//,
  /^apps\/worker\/src\/lib\/ops-connections-/,
  /^\.github\/scripts\/ops-exports-entrypoint\.mjs$/,
]

/** The money Worker's config: it counts only when its patch changes a line naming the binding or the ops Worker. */
const MONEY_CONFIG = 'apps/worker/wrangler.toml'
const BINDING_LINE = /\bOPS_CONNECTIONS\b|\bbidspoke-worker-ops\b/

/** Whether a unified diff patch adds or removes a line naming the binding or the ops Worker (headers and context lines aside). */
function patchNamesBinding(patch) {
  return patch.split('\n').some((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)( |$)/.test(line) && BINDING_LINE.test(line.slice(1)))
}

/**
 * Whether a pull request is measured, and why. `files` are the pull request's
 * files as GitHub lists them ({ filename, patch }), where an omitted patch (too
 * large to show) counts as touching the binding. When the list could not be
 * read the answer is to skip, unread: never to hold a money pull request on it.
 */
export function bindingCheckDecision(files, filesRead) {
  if (!filesRead) {
    return { measure: false, unread: true, reason: "the pull request's files could not be read, so whether it changes the OPS_CONNECTIONS binding or the ops Worker is unknown" }
  }
  for (const { filename, patch } of files) {
    if (BINDING_SURFACE.some((re) => re.test(filename))) return { measure: true, reason: `it changes ${filename}` }
    if (filename === MONEY_CONFIG) {
      if (typeof patch !== 'string') return { measure: true, reason: `it changes ${filename}, whose patch GitHub did not show` }
      if (patchNamesBinding(patch)) return { measure: true, reason: `its ${filename} patch changes a line naming OPS_CONNECTIONS or ${OPS}` }
    }
  }
  return { measure: false, reason: 'it changes neither the OPS_CONNECTIONS binding nor the ops Worker' }
}

/** The pull request files the CI step saved, one JSON object per line ({ filename, patch }), refused by line when malformed. */
export function readPrFiles(jsonl) {
  return jsonl.split('\n').map((line, i) => [line.trim(), i + 1]).filter(([line]) => line !== '').map(([line, n]) => {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      throw new Error(`the pull request file list is not JSON at line ${n}`)
    }
    if (entry === null || typeof entry !== 'object' || typeof entry.filename !== 'string') throw new Error(`the pull request file list has no file name at line ${n}`)
    return typeof entry.patch === 'string' ? { filename: entry.filename, patch: entry.patch } : { filename: entry.filename }
  })
}

/** The main module's source out of the multipart body content/v2 answers: index.js, or the one JavaScript module. */
export function mainModuleOf(body) {
  const boundary = /^--([^\r\n]+)\r?\n/.exec(body)?.[1]
  const modules = []
  if (boundary) {
    for (const part of body.split(`--${boundary}`)) {
      const split = part.indexOf('\r\n\r\n')
      if (split < 0) continue
      const head = part.slice(0, split)
      if (!/^Content-Type:\s*application\/javascript/im.test(head)) continue
      const name = /name="([^"]+)"/.exec(head)?.[1] ?? ''
      modules.push({ name, source: part.slice(split + 4).replace(/\r\n$/, '') })
    }
  }
  if (modules.length === 0) throw new Error('the script content holds no JavaScript module, so nothing could be read')
  const main = modules.find((m) => m.name === 'index.js') ?? (modules.length === 1 ? modules[0] : null)
  if (!main) throw new Error(`the script content holds ${modules.length} JavaScript modules and none is index.js, so its main module is unknown`)
  return main.source
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** [start, end) of the braces opening at `open`, skipping strings and comments. */
function braceSpan(src, open) {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1
      if (i === 0) return null
    } else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return [open, i + 1]
  }
  return null
}

/** Whether a bundled main module exports ENTRYPOINT as a WorkerEntrypoint class with every method. */
export function entrypointVerdict(source) {
  let local = null
  for (const list of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const spec of list[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(spec)
      if (m && (m[2] ?? m[1]) === ENTRYPOINT) local = m[1]
    }
  }
  if (!local) return { ok: false, lines: [`${OPS}: the deployed script does not export ${ENTRYPOINT}, so every call through the bidding Worker's OPS_CONNECTIONS binding would throw`] }

  const name = escape(local)
  const decl = new RegExp(`(?:\\b(?:var|let|const)\\s+${name}\\s*=\\s*class(?:\\s+[\\w$]+)?|\\bclass\\s+${name})\\s+extends\\s+WorkerEntrypoint\\d*\\s*\\{`).exec(source)
  if (!decl) return { ok: false, lines: [`${OPS}: the deployed ${ENTRYPOINT} (${local} in the bundle) is not a class extending WorkerEntrypoint`] }
  const span = braceSpan(source, decl.index + decl[0].length - 1)
  if (!span) return { ok: false, lines: [`${OPS}: the deployed ${ENTRYPOINT} class body could not be read to its end`] }
  const body = source.slice(...span)
  const missing = METHODS.filter((method) => !new RegExp(`^\\s+(?:async\\s+)?${escape(method)}\\s*\\(`, 'm').test(body))
  if (missing.length > 0) return { ok: false, lines: [`${OPS}: the deployed ${ENTRYPOINT} lacks ${missing.join(', ')}, so those calls through the binding would throw`] }
  return { ok: true, lines: [`${OPS}: the deployed script exports ${ENTRYPOINT}, a WorkerEntrypoint, with ${METHODS.join(', ')}`] }
}

async function cloudflareJson(fetchFn, token, url, what) {
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } })
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.success !== true) {
    const why = (Array.isArray(body?.errors) ? body.errors : []).map((e) => `${e?.code} ${e?.message}`).join('; ') || 'no error given'
    throw new Error(`${OPS}: reading its ${what} failed with ${res.status}: ${why}`)
  }
  return body.result
}

/** The verdict for the live ops Worker: its latest deployment's one version, read from the script content. */
export async function checkDeployedOps(fetchFn, token, account) {
  const base = `${API}/accounts/${account}/workers/scripts/${OPS}`
  const result = await cloudflareJson(fetchFn, token, `${base}/deployments`, 'deployments')
  const deployments = Array.isArray(result?.deployments) ? [...result.deployments] : []
  if (deployments.length === 0) throw new Error(`${OPS}: no deployment found, so nothing serves the OpsConnections entrypoint`)
  deployments.sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)))
  const latest = deployments[0]
  const versions = (Array.isArray(latest.versions) ? latest.versions : []).filter((v) => Number(v?.percentage) > 0)
  if (versions.length !== 1) {
    return { ok: false, lines: [`${OPS}: NOT MEASURED, the latest deployment (${latest.created_on}) is split across ${versions.length} versions and the content read cannot say which one it shows`] }
  }

  const res = await fetchFn(`${base}/content/v2`, { headers: { Authorization: `Bearer ${token}` } })
  const text = await res.text()
  if (!res.ok) throw new Error(`${OPS}: reading its script content failed with ${res.status}`)
  const verdict = entrypointVerdict(mainModuleOf(text))
  return { ok: verdict.ok, lines: [`${OPS}: version ${versions[0].version_id} serves 100% (deployed ${latest.created_on})`, ...verdict.lines] }
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token) {
    console.error('::error::CLOUDFLARE_API_TOKEN is not set, so whether the deployed ops Worker exports OpsConnections was not measured.')
    process.exit(1)
  }
  // On a pull request the CI step names the saved file list (PR_FILES) and whether it was read (PR_FILES_READ).
  if (process.env.PR_FILES_READ !== undefined) {
    let files = []
    let filesRead = process.env.PR_FILES_READ === 'true'
    if (filesRead) {
      try {
        files = readPrFiles(readFileSync(process.env.PR_FILES ?? '', 'utf8'))
      } catch (err) {
        console.error(`ops-exports-entrypoint: ${err instanceof Error ? err.message : 'the file list could not be read'}`)
        filesRead = false
      }
    }
    const decision = bindingCheckDecision(files, filesRead)
    if (!decision.measure) {
      if (decision.unread) {
        console.log(`::warning::The deployed ops Worker was not read: ${decision.reason}. Not measured rather than holding a pull request that may be a money hotfix; Deploy's "OPS_CONNECTIONS answers through the binding" job still calls through the binding after deploy.`)
      } else {
        console.log(`ops-exports-entrypoint: not measured, because ${decision.reason}.`)
      }
      return
    }
    console.log(`ops-exports-entrypoint: measured, because ${decision.reason}.`)
  }
  const here = dirname(realpathSync(fileURLToPath(import.meta.url)))
  const account = accountIdFrom(readFileSync(resolve(here, '../../apps/worker/wrangler.toml'), 'utf8'))
  let verdict
  try {
    verdict = await checkDeployedOps(fetch, token, account)
  } catch (err) {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
  for (const line of verdict.lines) (verdict.ok ? console.log : console.error)(verdict.ok ? line : `::error::${line}`)
  if (!verdict.ok) process.exit(1)
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main()
}
