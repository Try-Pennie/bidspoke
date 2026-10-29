// .github/scripts/bidding-exports-gateway.mjs: does the DEPLOYED bidding Worker's
// OpsGateway entrypoint have every method the ops Worker calls? (#2998, phase 2
// of #2982)
//
//   CLOUDFLARE_API_TOKEN=... node .github/scripts/bidding-exports-gateway.mjs
//
// The ops Worker's OPS_GATEWAY binding (apps/worker/wrangler.ops.toml) names
// the entrypoint OpsGateway of bidspoke-worker, and the ops Worker calls the
// methods OPS_GATEWAY_METHODS lists (apps/worker/src/lib/ops-gateway-contract.ts).
// Cloudflare deploys a binding to a method the bound Worker does not have
// green, and every call then throws (spike #2330), so an ops deploy calling a
// method before the bidding deploy carried it would fail every call: since
// #2998 that is opsRunVariables, which every run's variables come through. The
// repo cannot answer whether the LIVE bidding Worker has it, so this reads the
// live script, as ops-exports-entrypoint.mjs reads the ops Worker's (the same
// reading, shared from there): the latest deployment, refused when split across
// versions, then the script content, passing only when its main module exports
// OpsGateway as a class extending WorkerEntrypoint with every method.
//
// CI runs it only on a pull request that changes the ops Worker, the gateway
// contract, the ops Worker's config or either check (gatewayCheckDecision): a
// change to the bidding engine alone never waits on it. A pull request whose
// files cannot be read is skipped with a warning, never held (the rule
// ops-exports-entrypoint.mjs keeps, Hard Rule 1). Once measured, any API
// failure fails (L98).

import { readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accountIdFrom } from './worker-secret-parity.mjs'
import { checkDeployedScript, readPrFiles } from './ops-exports-entrypoint.mjs'

export const BIDDING = 'bidspoke-worker'
/** OPS_GATEWAY_METHODS in apps/worker/src/lib/ops-gateway-contract.ts; a guard holds the two equal. */
export const GATEWAY_METHODS = [
  'opsWorkflows', 'opsTickStarted', 'opsTickCompleted', 'opsJobStarted', 'opsJobCompleted', 'storeRotatedEnvelope', 'replaceConnectionEnvelope',
  'opsConnections', 'moneyIdentities', 'opsWorkflowDefinitions', 'opsRunVariables',
]
export const GATEWAY_SPEC = { worker: BIDDING, entrypoint: 'OpsGateway', methods: GATEWAY_METHODS, binding: "the ops Worker's OPS_GATEWAY binding" }

/** The pull request files that can change which OpsGateway methods the ops Worker calls. */
const GATEWAY_SURFACE = [
  /^apps\/worker\/src\/ops\//,
  /^apps\/worker\/src\/lib\/ops-gateway-contract\.ts$/,
  /^apps\/worker\/wrangler\.ops\.toml$/,
  /^\.github\/scripts\/bidding-exports-gateway\.mjs$/,
  /^\.github\/scripts\/ops-exports-entrypoint\.mjs$/,
]

/**
 * Whether a pull request is measured, and why. `files` are the pull request's
 * files ({ filename, patch }). When the list could not be read the answer is
 * to skip, unread: never to hold a pull request on it.
 */
export function gatewayCheckDecision(files, filesRead) {
  if (!filesRead) {
    return { measure: false, unread: true, reason: "the pull request's files could not be read, so whether it changes the ops Worker or the OpsGateway contract is unknown" }
  }
  for (const { filename } of files) {
    if (GATEWAY_SURFACE.some((re) => re.test(filename))) return { measure: true, reason: `it changes ${filename}` }
  }
  return { measure: false, reason: 'it changes neither the ops Worker nor the OpsGateway contract' }
}

/** The verdict for the live bidding Worker's OpsGateway. */
export async function checkDeployedBidding(fetchFn, token, account) {
  return checkDeployedScript(fetchFn, token, account, GATEWAY_SPEC)
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token) {
    console.error('::error::CLOUDFLARE_API_TOKEN is not set, so whether the deployed bidding Worker has every OpsGateway method was not measured.')
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
        console.error(`bidding-exports-gateway: ${err instanceof Error ? err.message : 'the file list could not be read'}`)
        filesRead = false
      }
    }
    const decision = gatewayCheckDecision(files, filesRead)
    if (!decision.measure) {
      if (decision.unread) {
        console.log(`::warning::The deployed bidding Worker was not read: ${decision.reason}. Not measured rather than holding a pull request on it.`)
      } else {
        console.log(`bidding-exports-gateway: not measured, because ${decision.reason}.`)
      }
      return
    }
    console.log(`bidding-exports-gateway: measured, because ${decision.reason}.`)
  }
  const here = dirname(realpathSync(fileURLToPath(import.meta.url)))
  const account = accountIdFrom(readFileSync(resolve(here, '../../apps/worker/wrangler.toml'), 'utf8'))
  let verdict
  try {
    verdict = await checkDeployedBidding(fetch, token, account)
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
