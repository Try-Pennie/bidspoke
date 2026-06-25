import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { contrastRatio, relativeLuminance, blendOver, parseHex } from '../contrast'

const WHITE = '#FFFFFF'

describe('contrast helpers (WCAG 2.1)', () => {
  it('parses 3- and 6-digit hex', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255])
    expect(parseHex('#1B72BA')).toEqual([27, 114, 186])
  })

  it('rejects invalid hex', () => {
    expect(() => parseHex('#xyz')).toThrow()
    expect(() => parseHex('1B72B')).toThrow()
  })

  it('luminance of black is 0 and white is 1', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5)
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5)
  })

  it('black-on-white is the maximum 21:1, identical colors are 1:1', () => {
    expect(contrastRatio('#000000', WHITE)).toBeCloseTo(21, 1)
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5)
  })

  it('is order-independent', () => {
    expect(contrastRatio(WHITE, '#1B72BA')).toBeCloseTo(contrastRatio('#1B72BA', WHITE), 5)
  })

  it('blends a translucent foreground over an opaque background', () => {
    expect(blendOver(WHITE, '#000000', 0.5)).toBe('#808080')
    expect(blendOver(WHITE, '#000000', 1)).toBe('#ffffff')
  })
})

// ── Integration guard: the brand action color clears AA ──────────────────────
const dir = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = path.resolve(dir, '../../../../..')
const WEB_SRC = path.join(REPO_ROOT, 'apps/web/src')

function readTailwindToken(token: 'light' | 'DEFAULT' | 'dark'): string {
  const cfg = readFileSync(path.join(REPO_ROOT, 'apps/web/tailwind.config.ts'), 'utf8')
  // Grab the `'p-blue': { ... }` block, then the requested key inside it.
  const block = cfg.match(/'p-blue':\s*\{([^}]*)\}/)?.[1] ?? ''
  const key = token === 'DEFAULT' ? 'DEFAULT' : token
  const hex = block.match(new RegExp(`${key}:\\s*'(#[0-9a-fA-F]{3,6})'`))?.[1]
  if (!hex) throw new Error(`Could not find p-blue.${token} in tailwind.config.ts`)
  return hex
}

describe('primary action color meets WCAG AA', () => {
  it('white text on p-blue.dark clears 4.5:1', () => {
    const dark = readTailwindToken('dark')
    const ratio = contrastRatio(WHITE, dark)
    expect(
      ratio,
      `White text on the primary button background (p-blue.dark = ${dark}) is ${ratio.toFixed(2)}:1, ` +
        `below the WCAG AA threshold of 4.5:1. Darken the token in tailwind.config.ts.`,
    ).toBeGreaterThanOrEqual(4.5)
  })
})

// ── Integration guard: no low-contrast text utilities in the UI ──────────────
function tsxFiles(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      out.push(...tsxFiles(full))
    } else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) {
      out.push(full)
    }
  }
  return out
}

// gray-400 on a light background is ~2.5:1 (fails AA). It is only acceptable on a
// solid dark surface, so a line is exempt when it sets a solid dark background
// utility, or carries an explicit `contrast-ok` opt-out. A translucent tint like
// `bg-black/5` is a light-surface overlay, not a dark background, so the negative
// lookahead excludes the `/opacity` forms.
const DARK_BG = /bg-(?:navy|graphite|black|gray-[789]00)(?![\w/])/
function grayViolations(src: string): { line: number; excerpt: string }[] {
  const out: { line: number; excerpt: string }[] = []
  src.split('\n').forEach((text, i) => {
    if (!/text-gray-400/.test(text)) return
    if (DARK_BG.test(text) || /contrast-ok/.test(text)) return
    out.push({ line: i + 1, excerpt: text.trim().slice(0, 100) })
  })
  return out
}

describe('no low-contrast text in the UI', () => {
  it('text-gray-400 is not used for text on light backgrounds (use gray-500)', () => {
    const violations: string[] = []
    for (const file of tsxFiles(WEB_SRC)) {
      for (const v of grayViolations(readFileSync(file, 'utf8'))) {
        violations.push(`  ${path.relative(REPO_ROOT, file)}:${v.line}  ${v.excerpt}`)
      }
    }
    expect(
      violations,
      `text-gray-400 (~2.5:1 on white) found on light backgrounds. Use text-gray-500 ` +
        `(4.8:1), or add a "contrast-ok" comment if the surface is genuinely dark:\n${violations.join('\n')}`,
    ).toEqual([])
  })

  it('primary buttons use the token hover, not the stale light hover hex', () => {
    const violations: string[] = []
    for (const file of tsxFiles(WEB_SRC)) {
      readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
        if (/#3A8FD0/i.test(text)) {
          violations.push(`  ${path.relative(REPO_ROOT, file)}:${i + 1}  ${text.trim().slice(0, 100)}`)
        }
      })
    }
    expect(
      violations,
      `Stale hover hex #3A8FD0 (lighter than the new p-blue.dark) found. Use the ` +
        `darker hover bg-[#155E99]:\n${violations.join('\n')}`,
    ).toEqual([])
  })
})
