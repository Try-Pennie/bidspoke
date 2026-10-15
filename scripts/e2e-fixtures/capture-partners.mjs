#!/usr/bin/env node
/**
 * Capture the partners page's Worker reads for the accessibility job (#2134).
 *
 * The axe job answers every Worker call the partners page makes from recorded
 * responses (Playwright page.route, apps/web/e2e/partner-fixtures.ts), so it
 * never waits on production and a test that saves never writes to it. This
 * script records those responses, READ ONLY: it sends GET requests and nothing
 * else, for every partner of the signed in person's organisation, redacts them
 * (redact.mjs) and writes them to apps/web/e2e/fixtures/partners/:
 *
 *   partners.json            GET /api/partners
 *   buyer-profiles.json      GET /api/partners/:id/buyer-profile, by partner id, for each buyer
 *   partner-uuids.json       GET /api/partner-uuids
 *   partner-bid-configs.json GET /api/partner-bid-configs?partner_id=:id, by partner id, for each buyer
 *
 * The files under synthetic/ (the 409 a save is answered with, a matrix to
 * delete, the usage panels' answers) are made by hand and never touched here.
 *
 * Usage, with an access token of a person signed in to Bidspoke (copy it from
 * the browser's session; it is read from the environment and never printed):
 *
 *   BIDSPOKE_WORKER_URL=https://api.trypennie.dev BIDSPOKE_ACCESS_TOKEN=... node scripts/e2e-fixtures/capture-partners.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRedactor } from './redact.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const FIXTURE_DIR = path.resolve(HERE, '../../apps/web/e2e/fixtures/partners')

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

/**
 * Write the captured responses, redacted. Exported so the first set (assembled
 * from read only SELECTs of the same rows, see the PR for #2134) went through
 * the same redaction a capture does.
 */
export function writeFixtures({ partners, profiles, uuids, bidConfigs }, outDir = FIXTURE_DIR) {
  const redact = createRedactor()
  mkdirSync(outDir, { recursive: true })
  // Code point order, not the machine's locale, so every machine writes the same bytes.
  const bySlug = [...partners].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
  writeFileSync(path.join(outDir, 'partners.json'), json(bySlug.map((p) => redact.partner(p))))
  const profileOut = {}
  for (const p of bySlug) {
    if (profiles[p.id]) profileOut[p.id] = { ...profiles[p.id], profile: redact.profile(profiles[p.id].profile) }
  }
  writeFileSync(path.join(outDir, 'buyer-profiles.json'), json(profileOut))
  writeFileSync(path.join(outDir, 'partner-uuids.json'), json(uuids))
  const configsOut = {}
  for (const p of bySlug) if (bidConfigs[p.id]) configsOut[p.id] = bidConfigs[p.id].map((c) => redact.partner(c))
  writeFileSync(path.join(outDir, 'partner-bid-configs.json'), json(configsOut))
}

async function get(base, token, route) {
  const res = await fetch(`${base}${route}`, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`GET ${route} answered ${res.status}, so nothing was written`)
  return res.json()
}

/** A read whose answer must be a list, refused at the read rather than after every other read. */
async function getList(base, token, route) {
  const body = await get(base, token, route)
  if (!Array.isArray(body)) throw new Error(`GET ${route} did not answer a list, so nothing was written`)
  return body
}

async function main() {
  const base = (process.env.BIDSPOKE_WORKER_URL ?? '').replace(/\/$/, '')
  const token = process.env.BIDSPOKE_ACCESS_TOKEN ?? ''
  if (!base || !token) {
    console.error('capture-partners: set BIDSPOKE_WORKER_URL and BIDSPOKE_ACCESS_TOKEN; nothing was read or written.')
    process.exit(1)
  }
  const partners = await getList(base, token, '/api/partners')
  const buyers = partners.filter((p) => p.partner_type === 'buyer' || p.partner_type === 'both')
  const profiles = {}
  const bidConfigs = {}
  for (const p of buyers) {
    profiles[p.id] = await get(base, token, `/api/partners/${p.id}/buyer-profile`)
    bidConfigs[p.id] = await getList(base, token, `/api/partner-bid-configs?partner_id=${p.id}`)
  }
  const uuids = await getList(base, token, '/api/partner-uuids')
  writeFixtures({ partners, profiles, uuids, bidConfigs })
  console.log(`capture-partners: wrote ${partners.length} partners, ${buyers.length} buyers, ${uuids.length} sub-account IDs to ${FIXTURE_DIR}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`capture-partners: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
