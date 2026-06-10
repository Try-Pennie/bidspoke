// Documentation coverage guardrails.
//
// These tests fail when the platform gains a surface that the public docs (the
// repo-root docs/, published at /docs and via llms.txt) do not yet cover, so a
// code change that needs a docs update cannot land silently. They are structural
// (does a surface have a page / an index entry), not semantic (they do not check
// that prose is accurate). When one fails, update the docs (or, for a
// deliberately undocumented internal surface, add it to the relevant exclusion
// list below with a reason).
//
// This lives in the web package because it needs Node fs and because the docs
// publishing logic (scripts/sync-docs.mjs) lives here too. It reads worker
// source as plain text to enumerate node types and API routes.

import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))
const workerSrc = path.resolve(dir, '../../../../worker/src')
const repoRoot = path.resolve(dir, '../../../../..')
const docsRoot = path.join(repoRoot, 'docs')

const read = (p: string) => readFileSync(p, 'utf8')
const nodeTypeToSlug = (type: string) => type.replace(/_/g, '-')

// Positive publish rule, kept in sync with scripts/sync-docs.mjs: a page is
// published only if it is the top-level README.md or lives under one of the
// content directories. Internal build notes at the docs/ root are excluded.
const CONTENT_DIRS = new Set(['concepts', 'nodes', 'guides', 'reference', 'examples'])
const EXCLUDE = new Set(['reference/README.md'])

function isPublished(rel: string): boolean {
  if (!rel.endsWith('.md') || EXCLUDE.has(rel)) return false
  if (rel === 'README.md') return true
  return CONTENT_DIRS.has(rel.split('/')[0])
}

function walkMarkdown(rel = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(path.join(docsRoot, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walkMarkdown(childRel))
    else if (isPublished(childRel)) out.push(childRel)
  }
  return out
}

describe('docs coverage: node types', () => {
  // Every node type the engine can execute should have a docs/nodes/<slug>.md
  // page. Passive join nodes are documented inside their parent node's page.
  const DOCUMENTED_IN_PARENT = new Set(['branch_end', 'parallel_end'])

  const dispatch = read(path.join(workerSrc, 'engine/nodes/index.ts'))
  const engineNodeTypes = [...dispatch.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1])

  it('extracts node types from the engine dispatch', () => {
    // Sanity check: if this drops near zero the regex broke and the rest of the
    // suite would pass vacuously.
    expect(engineNodeTypes.length).toBeGreaterThan(10)
  })

  for (const type of engineNodeTypes) {
    if (DOCUMENTED_IN_PARENT.has(type)) continue
    it(`node type '${type}' has docs/nodes/${nodeTypeToSlug(type)}.md`, () => {
      const page = path.join(docsRoot, 'nodes', `${nodeTypeToSlug(type)}.md`)
      expect(
        existsSync(page),
        `Engine handles node type '${type}' but docs/nodes/${nodeTypeToSlug(type)}.md is missing. ` +
          `Add a doc page for it (or, if it is a passive join node, add it to DOCUMENTED_IN_PARENT).`,
      ).toBe(true)
    })
  }

  it('every node page is linked from the node catalog', () => {
    const catalog = read(path.join(docsRoot, 'nodes', 'README.md'))
    const pages = readdirSync(path.join(docsRoot, 'nodes')).filter(
      (f) => f.endsWith('.md') && f !== 'README.md',
    )
    for (const page of pages) {
      expect(catalog, `docs/nodes/${page} is not linked from docs/nodes/README.md`).toContain(page)
    }
  })
})

describe('docs coverage: API resources', () => {
  // Every resource router mounted under /api should appear in the API reference.
  const apiIndex = read(path.join(workerSrc, 'routes/api/index.ts'))
  const mounted = [...apiIndex.matchAll(/\.route\('(\/[a-z-]+)'/g)].map((m) => m[1])
  const inline = [...apiIndex.matchAll(/\.(?:get|post|put|patch|delete)\('(\/[a-z-]+)'/g)].map(
    (m) => m[1],
  )
  const resources = [...new Set([...mounted, ...inline])]
  const apiMd = read(path.join(docsRoot, 'reference', 'api.md'))

  // Internal-only surfaces intentionally not in the public reference.
  const UNDOCUMENTED_OK = new Set<string>([])

  it('finds the mounted API resources', () => {
    expect(mounted.length).toBeGreaterThan(10)
  })

  for (const route of resources) {
    if (UNDOCUMENTED_OK.has(route)) continue
    it(`API resource /api${route} is documented`, () => {
      expect(
        apiMd.includes(`/api${route}`),
        `/api${route} is mounted in routes/api/index.ts but not mentioned in docs/reference/api.md. ` +
          `Document it (or add it to UNDOCUMENTED_OK with a reason).`,
      ).toBe(true)
    })
  }
})

describe('docs coverage: llms.txt index', () => {
  // Every published doc page must be referenced in the AI crawl index so an
  // assistant pointed at llms.txt can discover all of them.
  const llms = read(path.join(repoRoot, 'llms.txt'))
  const pages = walkMarkdown()

  it('finds published doc pages', () => {
    expect(pages.length).toBeGreaterThan(20)
  })

  for (const rel of pages) {
    it(`llms.txt references docs/${rel}`, () => {
      expect(
        llms.includes(`/docs/${rel}`),
        `docs/${rel} is published but not listed in llms.txt. Add a link so AI crawlers find it.`,
      ).toBe(true)
    })
  }
})
