import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * What CLAUDE.md loads into every session (#2606).
 *
 * A line `@<path>` in CLAUDE.md imports that file whole, as instructions, into
 * every Claude Code session started in this repo. On 2026-10-21 a new session
 * opened warning that its instruction files came to 173.5k characters, over
 * the platform's 150k total. The largest was the planning list (47.4k,
 * #2606), imported by name. It is read when a task touches it, not a rule
 * every session must follow, and past the total the platform keeps loading
 * everything while warning on every start, so the rules that matter are
 * buried in a planning list.
 *
 * So the planning list is linked, never imported (#2606), and the project's own share of the
 * total (CLAUDE.md plus everything it imports) stays under a budget. The
 * global files loaded beside it came to about 83k on 2026-10-21, which leaves
 * the project roughly 67k before the 150k total; 60k keeps a margin.
 */

const CLAUDE_MD = path.join(REPO_ROOT, 'CLAUDE.md')
const PROJECT_SHARE_BUDGET = 60_000

// An `@path` anywhere in the text imports that file, in a sentence as well as
// alone on a line, except inside code, which is how the platform reads it. A
// word after @ that names no file (a package like an npm scope) loads nothing.
function importsOf(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  return [...prose.matchAll(/(?:^|[\s(])@([^\s()`]+)/gm)].map((m) => m[1].replace(/[.,;:]+$/, ''))
}

// Every file a session loads from CLAUDE.md: the file itself and its imports,
// followed into imported files too, each resolved from the file naming it.
function loadedFiles(root: string): string[] {
  const seen = new Set<string>()
  const visit = (file: string, depth: number) => {
    if (seen.has(file) || depth > 5) return
    seen.add(file)
    for (const ref of importsOf(fs.readFileSync(file, 'utf8'))) {
      const target = path.resolve(path.dirname(file), ref)
      if (fs.existsSync(target) && fs.statSync(target).isFile()) visit(target, depth + 1)
    }
  }
  visit(root, 0)
  return [...seen]
}

describe('importsOf', () => {
  it('reads an import alone on a line and one inside a sentence', () => {
    expect(importsOf('@TODO.md\nsee @docs/plan.md, then go')).toEqual(['TODO.md', 'docs/plan.md'])
  })

  it('ignores an @ inside code and an address', () => {
    expect(importsOf('run `@cloudflare/vitest-plugin`\n```\n@TODO.md\n```\nmail a@b.com')).toEqual([])
  })
})

describe('CLAUDE.md imports (#2606)', () => {
  const text = fs.readFileSync(CLAUDE_MD, 'utf8')
  const loaded = loadedFiles(CLAUDE_MD)

  it('does not load TODO.md, and links it instead', () => {
    // Resolved and case folded, so any spelling of the planning list's path is caught (#2606).
    const planningList = path.join(REPO_ROOT, 'TODO.md').toLowerCase()
    expect(
      loaded.map((f) => f.toLowerCase()),
      'a session loads TODO.md whole; link it',
    ).not.toContain(planningList)
    expect(text).toMatch(/\[TODO\.md\]\(\.\/TODO\.md\)/)
  })

  it('finds the imports it measures', () => {
    // The design context is imported on purpose; finding it proves the walk
    // reads the imports rather than passing on CLAUDE.md alone (L1).
    expect(loaded).toContain(path.join(REPO_ROOT, '.impeccable.md'))
  })

  it('keeps CLAUDE.md and everything it loads under the project budget', () => {
    const sizes = loaded.map((file) => ({
      file: path.relative(REPO_ROOT, file),
      chars: fs.readFileSync(file, 'utf8').length,
    }))
    const total = sizes.reduce((sum, s) => sum + s.chars, 0)
    expect(total, `CLAUDE.md and what it loads come to ${total} characters: ${JSON.stringify(sizes)}`).toBeLessThan(
      PROJECT_SHARE_BUDGET,
    )
  })
})
