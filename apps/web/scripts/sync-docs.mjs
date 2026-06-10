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

// Internal dev docs that should NOT be published on the public site.
const BLOCKLIST = new Set([
  'engine-cutover-scope.md',
  'gigfi-port-plan.md',
  'partner-proxy-to-bidspoke.md',
  'reference/README.md',
])

async function walk(dir, base = '') {
  const out = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...(await walk(path.join(dir, entry.name), rel)))
    } else if (entry.name.endsWith('.md') && !BLOCKLIST.has(rel)) {
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
