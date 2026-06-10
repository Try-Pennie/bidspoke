// Publishes the repo's user-facing docs (../../docs) as static assets under
// apps/web/public/docs so the /docs site and AI crawlers can read them.
// Single source of truth is the docs/ folder; this script only copies + indexes.
// Run via `pnpm run docs:sync` (also wired into predev/prebuild).

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DOCS_SRC = path.resolve(__dirname, '../../../docs')
const DOCS_OUT = path.resolve(__dirname, '../public/docs')

// Positive publish rule (kept in sync with the docs-coverage test in
// apps/worker/src/__tests__/docs-coverage.test.ts). A markdown file is published
// only if it is the top-level README.md or lives under one of the content
// directories below. Internal build notes dropped at the docs/ root (e.g.
// engine-cutover-scope.md, gigfi-port-plan.md) are therefore never published.
const CONTENT_DIRS = new Set(['concepts', 'nodes', 'guides', 'reference', 'examples'])
// Files inside a content directory that are still internal, not public docs.
const EXCLUDE = new Set(['reference/README.md'])

export function isPublished(rel) {
  if (!rel.endsWith('.md') || EXCLUDE.has(rel)) return false
  if (rel === 'README.md') return true
  return CONTENT_DIRS.has(rel.split('/')[0])
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

// Pull the first H1 as the page title; fall back to the filename.
function titleOf(markdown, rel) {
  const m = markdown.match(/^#\s+(.+)$/m)
  if (m) return m[1].trim()
  return rel.replace(/\.md$/, '').split('/').pop()
}

async function main() {
  await fs.rm(DOCS_OUT, { recursive: true, force: true })
  const files = (await walk(DOCS_SRC)).sort()
  const nav = []

  for (const rel of files) {
    const src = path.join(DOCS_SRC, rel)
    const dst = path.join(DOCS_OUT, rel)
    const markdown = await fs.readFile(src, 'utf8')
    await fs.mkdir(path.dirname(dst), { recursive: true })
    await fs.writeFile(dst, markdown)
    nav.push({
      // Route slug (no .md): docs/concepts/overview.md -> concepts/overview
      slug: rel.replace(/\.md$/, '').replace(/\/README$/, ''),
      path: rel,
      title: titleOf(markdown, rel),
      section: rel.includes('/') ? rel.split('/')[0] : 'root',
    })
  }

  await fs.writeFile(path.join(DOCS_OUT, '_nav.json'), JSON.stringify(nav, null, 2))

  // Publish the canonical repo-root llms.txt at the site root (/llms.txt).
  const llmsSrc = path.resolve(__dirname, '../../../llms.txt')
  await fs.copyFile(llmsSrc, path.resolve(__dirname, '../public/llms.txt'))

  console.log(`Synced ${files.length} doc pages + llms.txt to apps/web/public`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
