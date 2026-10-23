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

function importsOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^@\S+$/.test(line))
    .map((line) => line.slice(1))
}

describe('CLAUDE.md imports (#2606)', () => {
  const text = fs.readFileSync(CLAUDE_MD, 'utf8')
  const imports = importsOf(text)

  it('does not import TODO.md, and links it instead', () => {
    expect(imports, 'CLAUDE.md imports TODO.md whole into every session; link it').not.toContain('TODO.md')
    expect(text).toMatch(/\[TODO\.md\]\(\.\/TODO\.md\)/)
  })

  it('finds the imports it measures', () => {
    // The design context is imported on purpose; finding it proves the parser
    // reads the import lines rather than passing on an empty list (L1).
    expect(imports).toContain('.impeccable.md')
  })

  it('keeps CLAUDE.md and everything it imports under the project budget', () => {
    const sizes = [CLAUDE_MD, ...imports.map((p) => path.join(REPO_ROOT, p))].map((file) => ({
      file: path.relative(REPO_ROOT, file),
      chars: fs.readFileSync(file, 'utf8').length,
    }))
    const total = sizes.reduce((sum, s) => sum + s.chars, 0)
    expect(total, `CLAUDE.md and its imports come to ${total} characters: ${JSON.stringify(sizes)}`).toBeLessThan(
      PROJECT_SHARE_BUDGET,
    )
  })
})
