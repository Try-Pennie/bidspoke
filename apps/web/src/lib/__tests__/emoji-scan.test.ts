import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { findEmoji } from '../emoji-scan'
import { REPO_ROOT, WEB_SRC, listTsxFiles } from './_scan-utils'

describe('findEmoji', () => {
  it('flags a unicode emoji glyph', () => {
    const hits = findEmoji('const t = "Deploy failed 🚨"\n')
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toBe('unicode')
    expect(hits[0].line).toBe(1)
  })

  it('flags a Slack emoji shortcode when shortcodes are enabled', () => {
    const hits = findEmoji('TEXT=:rotating_light: *Deploy failed*\n', { shortcodes: true })
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toBe('shortcode')
  })

  it('ignores shortcodes when not enabled (TS/TSX context)', () => {
    expect(findEmoji('const x = cond ? a : b\n')).toEqual([])
    expect(findEmoji(':warning: text\n')).toEqual([])
  })

  it('does not treat a clock time as a shortcode', () => {
    expect(findEmoji('time is 12:00:00 today\n', { shortcodes: true })).toEqual([])
  })

  it('does not treat YAML key: value as a shortcode', () => {
    expect(findEmoji('  channel: alerts\n', { shortcodes: true })).toEqual([])
  })

  it('honors an emoji-ok opt-out on the same line', () => {
    expect(findEmoji('const t = "ok 🚨" // emoji-ok: decorative\n')).toEqual([])
    expect(findEmoji('TEXT=:warning: x // emoji-ok\n', { shortcodes: true })).toEqual([])
  })

  it('ignores plain text with colons but no emoji', () => {
    expect(findEmoji('*How to fix:* run the command\n', { shortcodes: true })).toEqual([])
  })

  it('does not flag typographic arrows used as plain glyphs', () => {
    expect(findEmoji('// Switch view↔edit and open →\n')).toEqual([])
    expect(findEmoji('const t = "Open workflow →"\n')).toEqual([])
  })

  it('flags a text-default symbol forced to emoji with the variation selector', () => {
    const hits = findEmoji('const t = "Heads up ⚠️ now"\n')
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toBe('unicode')
  })

  it('does not flag a GitHub Actions ::command:: as a shortcode', () => {
    expect(findEmoji('echo "::error::bad thing"\n', { shortcodes: true })).toEqual([])
    expect(findEmoji("grep -E '[[:space:]]+'\n", { shortcodes: true })).toEqual([])
  })
})

// ── Integration guard: no emoji in alert copy ───────────────────────────────
function ymlFiles(root: string): string[] {
  return readdirSync(root)
    .filter((e) => e.endsWith('.yml') || e.endsWith('.yaml'))
    .map((e) => path.join(root, e))
}

describe('no emoji in alert copy', () => {
  it('UI (.tsx) and Slack message copy use no unicode emoji', () => {
    const files = [
      ...listTsxFiles(WEB_SRC),
      path.join(REPO_ROOT, 'apps/worker/src/lib/slack.ts'),
    ]
    const violations: string[] = []
    for (const file of files) {
      for (const h of findEmoji(readFileSync(file, 'utf8'))) {
        violations.push(`  ${path.relative(REPO_ROOT, file)}:${h.line}  ${h.excerpt}`)
      }
    }
    expect(violations, `Emoji found in alert/UI copy (no emoji in alerts):\n${violations.join('\n')}`).toEqual([])
  })

  it('GitHub Actions Slack alerts use no emoji (unicode or :shortcode:)', () => {
    const violations: string[] = []
    for (const file of ymlFiles(path.join(REPO_ROOT, '.github/workflows'))) {
      for (const h of findEmoji(readFileSync(file, 'utf8'), { shortcodes: true })) {
        violations.push(`  ${path.relative(REPO_ROOT, file)}:${h.line}  [${h.kind}] ${h.excerpt}`)
      }
    }
    expect(violations, `Emoji found in workflow Slack alerts (no emoji in alerts):\n${violations.join('\n')}`).toEqual([])
  })
})
