// Docs integrity gate, run in CI (and on demand via `pnpm --filter=web docs:check`).
// Fails (exit 1) when:
//   1. A relative markdown link in any PUBLISHED doc points at a file that is
//      not published (missing, renamed, or excluded by the publish rule) —
//      moved/renamed pages and deleted guides surface here instead of as 404s
//      on the live /docs site.
//   2. A docs link in the repo-root llms.txt does not resolve to a published
//      page (llms.txt is hand-maintained, so it drifts when pages move).
//   3. The sync itself fails (missing docs/ tree, unreadable file).
//
// External links (http/https/mailto) are not checked — this is an integrity
// gate for OUR tree, not a dead-external-link crawler.
//
// The pure check lives in collectDocErrors so apps/web/src/lib/__tests__/
// check-docs.test.ts can exercise the link rules without touching the disk.

import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isPublished } from './sync-docs.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DOCS_SRC = path.resolve(__dirname, '../../../docs')
const LLMS_TXT = path.resolve(__dirname, '../../../llms.txt')

// Markdown links: [text](target). Skips external protocols and pure in-page
// anchors via isRelativeDocLink.
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

export function isRelativeDocLink(target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false // http:, https:, mailto:
  if (target.startsWith('#')) return false // in-page anchor
  if (target.startsWith('/')) return false // site-absolute (validated by route, not tree)
  return true
}

/**
 * Pure integrity check.
 * @param pages Map of published rel path -> markdown content
 * @param llmsTxt content of the repo-root llms.txt
 * @param assetExists (relPath) => boolean, for non-.md link targets
 * @returns string[] of human-readable errors (empty = pass)
 */
export function collectDocErrors(pages, llmsTxt, assetExists = () => false) {
  const published = new Set(pages.keys())
  const errors = []

  for (const rel of [...published].sort()) {
    const markdown = pages.get(rel)
    for (const match of markdown.matchAll(LINK_RE)) {
      const raw = match[1]
      if (!isRelativeDocLink(raw)) continue
      const targetPath = raw.split('#')[0]
      if (targetPath === '') continue
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), targetPath))
      if (resolved.startsWith('..')) {
        // One sanctioned escape: the repo-root llms.txt, which sync-docs
        // publishes at the site root so /docs/README.md may link up to it.
        if (resolved === '../llms.txt') continue
        errors.push(`${rel}: link escapes the docs tree: (${raw})`)
        continue
      }
      // Only .md targets must be published pages; other assets just need to exist.
      if (resolved.endsWith('.md')) {
        if (!published.has(resolved)) errors.push(`${rel}: broken link to unpublished/missing page: (${raw})`)
      } else if (!assetExists(resolved)) {
        errors.push(`${rel}: broken link to missing file: (${raw})`)
      }
    }
  }

  // llms.txt: every /docs/<page>.md URL must map to a published page.
  for (const match of llmsTxt.matchAll(/https?:\/\/[^/]+\/docs\/([^)\s]+\.md)/g)) {
    const rel = match[1]
    if (!published.has(rel)) errors.push(`llms.txt: links to unpublished/missing page: ${rel}`)
  }

  return errors
}

/**
 * Coverage check (#382): the reverse of the llms.txt link rule — every PUBLISHED
 * page must be listed in llms.txt so a new doc cannot ship undiscoverable. Run by
 * docs:check (and thus the pre-push hook), so a missing index entry fails locally
 * instead of only in the separate CI docs-coverage test.
 * @param pages Map of published rel path -> markdown content
 * @param llmsTxt content of the repo-root llms.txt
 * @returns string[] of human-readable errors (empty = pass)
 */
export function collectCoverageErrors(pages, llmsTxt) {
  const errors = []
  for (const rel of [...pages.keys()].sort()) {
    if (!llmsTxt.includes(`/docs/${rel}`)) {
      errors.push(`docs/${rel} is published but not listed in llms.txt. Add a link so AI crawlers find it.`)
    }
  }
  return errors
}

async function walk(dir, base = '') {
  const out = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...(await walk(path.join(dir, entry.name), rel)))
    } else if (isPublished(rel)) {
      out.push(rel)
    }
  }
  return out
}

async function main() {
  const files = await walk(DOCS_SRC)
  const pages = new Map()
  for (const rel of files) {
    pages.set(rel, await fs.readFile(path.join(DOCS_SRC, rel), 'utf8'))
  }
  const llms = await fs.readFile(LLMS_TXT, 'utf8')

  const errors = [
    ...collectDocErrors(pages, llms, (rel) => existsSync(path.join(DOCS_SRC, rel))),
    ...collectCoverageErrors(pages, llms),
  ]

  if (errors.length > 0) {
    console.error(`Docs integrity check FAILED (${errors.length} problem${errors.length === 1 ? '' : 's'}):`)
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }
  console.log(`Docs integrity check passed: ${pages.size} published pages, all relative links resolve + every page is in llms.txt.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
