// .github/scripts/worker-secret-parity.mjs: Worker secret parity (#1709, plan 0.E).
//
//   CLOUDFLARE_API_TOKEN=... node .github/scripts/worker-secret-parity.mjs
//
// Reads the NAMES of the secrets set on each Worker through the Cloudflare API
// (never a value) and fails when:
// - the money Worker (bidspoke-worker) lacks a secret it requires;
// - the ops Worker (bidspoke-worker-ops) holds a secret its allowlist does not
//   name, above all a money Worker secret (the main service key, the encryption
//   key, the SSN pepper, a partner credential), or lacks one it requires.
// The lists are apps/worker/src/lib/secret-lists.ts, the same ones the daily guard
// reads. Until OPS_WORKER_DEPLOYED is true the ops side is reported as not
// measured; after, a missing ops Worker fails. Any API failure fails (L98).

import { readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  OPS_ALLOWED_SECRETS,
  OPS_REQUIRED_SECRETS,
  OPS_WORKER_DEPLOYED,
  REQUIRED_PARTNER_SECRETS,
  REQUIRED_SECRETS,
} from '../../apps/worker/src/lib/secret-lists.ts'

const MONEY = 'bidspoke-worker'
const OPS = 'bidspoke-worker-ops'
/** Cloudflare's error code for a script that does not exist on the account. */
const SCRIPT_NOT_FOUND = 10007

/** The account id the money Worker's wrangler.toml deploys to. */
export function accountIdFrom(toml) {
  const m = /^\s*account_id\s*=\s*"([0-9a-f]{32})"\s*$/m.exec(toml)
  if (!m) throw new Error('wrangler.toml names no account_id')
  return m[1]
}

/** The secret names set on one script, or deployed false when the script does not exist. */
export async function listSecretNames(fetchFn, token, account, script) {
  const res = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${script}/secrets`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = await res.json().catch(() => null)
  const errors = Array.isArray(body?.errors) ? body.errors : []
  if (res.status === 404 && errors.some((e) => e?.code === SCRIPT_NOT_FOUND)) return { deployed: false, names: [] }
  if (!res.ok || body?.success !== true || !Array.isArray(body.result)) {
    const why = errors.map((e) => `${e?.code} ${e?.message}`).join('; ') || 'no error given'
    throw new Error(`${script}: listing secrets failed with ${res.status}: ${why}`)
  }
  return { deployed: true, names: body.result.map((s) => s.name).sort() }
}

/** The verdict for both Workers. */
export function parityVerdict(money, ops, lists, opsDeployed) {
  const lines = []
  let ok = true
  if (!money.deployed) {
    lines.push(`${MONEY}: not found on the account`)
    ok = false
  } else {
    const missing = lists.moneyRequired.filter((n) => !money.names.includes(n))
    for (const n of missing) lines.push(`${MONEY}: missing required ${n}`)
    if (missing.length === 0) lines.push(`${MONEY}: ${money.names.length} secret(s), every required one present`)
    ok &&= missing.length === 0
  }

  if (!ops.deployed) {
    if (opsDeployed) {
      lines.push(`${OPS}: not deployed, but OPS_WORKER_DEPLOYED says it is`)
      ok = false
    } else {
      lines.push(`${OPS}: NOT MEASURED, not deployed yet (OPS_WORKER_DEPLOYED is false)`)
    }
    return { ok, lines }
  }
  const problems = []
  for (const n of ops.names) {
    if (lists.opsAllowed.includes(n)) continue
    problems.push(lists.moneyRequired.includes(n) || (money.deployed && money.names.includes(n))
      ? `${OPS}: holds ${n}, a money Worker secret`
      : `${OPS}: holds ${n}, which its allowlist does not name`)
  }
  for (const n of lists.opsRequired) if (!ops.names.includes(n)) problems.push(`${OPS}: missing required ${n}`)
  if (problems.length === 0) lines.push(`${OPS}: ${ops.names.length} secret(s), all allowed, every required one present`)
  lines.push(...problems)
  return { ok: ok && problems.length === 0, lines }
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token) {
    console.error('worker secret parity: CLOUDFLARE_API_TOKEN is not set, so nothing was checked')
    process.exit(1)
  }
  const here = dirname(fileURLToPath(import.meta.url))
  const account = accountIdFrom(readFileSync(resolve(here, '../../apps/worker/wrangler.toml'), 'utf8'))
  const lists = {
    moneyRequired: [...REQUIRED_SECRETS, ...REQUIRED_PARTNER_SECRETS],
    opsRequired: [...OPS_REQUIRED_SECRETS],
    opsAllowed: [...OPS_ALLOWED_SECRETS],
  }
  try {
    const money = await listSecretNames(fetch, token, account, MONEY)
    const ops = await listSecretNames(fetch, token, account, OPS)
    const verdict = parityVerdict(money, ops, lists, OPS_WORKER_DEPLOYED)
    for (const line of verdict.lines) console.log(line)
    process.exit(verdict.ok ? 0 : 1)
  } catch (err) {
    console.error(`worker secret parity: ${err instanceof Error ? err.message : 'the check threw'}`)
    process.exit(1)
  }
}

// Run only as the entry script, compared as real paths, as scan-coverage.mjs does
// (L98, L740).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
