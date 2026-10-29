import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * What CLAUDE.md loads into every session (#2606).
 *
 * An `@<path>` in CLAUDE.md, alone on a line or inside a sentence, imports that
 * file whole (and whatever it imports in turn), as instructions, into
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

/**
 * The same total counted in tokens, the unit a session actually pays in (#2192).
 * Rules text measured at about 2.78 characters per token in the session audit
 * behind #2192 (1 to 15 October 2026), not the 3.7 often assumed, so a
 * character budget alone undercounts by about a quarter. Every request in a
 * session re-reads this total, so each line here is paid for once per message.
 *
 * Set 537 tokens above the size after the third #2192 cut (9,006 tokens, down
 * from 14,963 on 2026-10-29), the same headroom the second cut left. The
 * second cut (18,172 down to 14,963) moved the task only runbooks (migration
 * mechanics, the Worker secrets table, the encryption key rotation, the push
 * to main history, the Cloudflare log access history) into docs. The third
 * moved the package and app detail into each one's README.md, the ops Worker,
 * run variable and step test mechanics into docs/ops-worker.md, the ops
 * connection mechanics into docs/ops-connections-logins.md, the binding's
 * deadlines into docs/disaster-recovery.md, the partner save detail into
 * docs/reference/partners.md and the App Action step into
 * docs/nodes/app-action.md. Each left a one or two line rule pointing at its
 * doc. When this fails, move a runbook, history or measurement into docs/ and
 * leave the rule that points to it, rather than raising the ceiling.
 */
const CHARS_PER_TOKEN = 2.78
const PROJECT_TOKEN_BUDGET = 9_543

function tokensOf(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

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

  it('keeps CLAUDE.md and everything it loads under the token budget (#2192)', () => {
    const sizes = loaded.map((file) => ({
      file: path.relative(REPO_ROOT, file),
      tokens: tokensOf(fs.readFileSync(file, 'utf8').length),
    }))
    const total = sizes.reduce((sum, s) => sum + s.tokens, 0)
    expect(
      total,
      `CLAUDE.md and what it loads come to about ${total} tokens at ${CHARS_PER_TOKEN} characters a token, ` +
        `over the ${PROJECT_TOKEN_BUDGET} budget: ${JSON.stringify(sizes)}. Move a runbook or history into docs/ ` +
        'and leave the one line rule that points to it.',
    ).toBeLessThanOrEqual(PROJECT_TOKEN_BUDGET)
  })
})

describe('tokensOf', () => {
  it('counts 2.78 characters a token, rounding a part token up', () => {
    expect(tokensOf(278)).toBe(100)
    expect(tokensOf(279)).toBe(101)
    expect(tokensOf(0)).toBe(0)
  })
})
