import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WEB_SRC, listFiles, sanitizeSource } from './_scan-utils'

/**
 * The canvas editor must stay self-hosted (#2695).
 *
 * `@monaco-editor/react` fetches Monaco from cdn.jsdelivr.net unless it is handed
 * a copy, and that CDN bundle carries DOMPurify 3.2.7 (GHSA-mrv2-3pqr-j5jr), out
 * of reach of the lockfile. Three things keep the patched copy the one that runs,
 * and each can be undone by an edit that still builds and still shows an editor:
 *
 *   1. Only MonacoEditor.tsx imports `@monaco-editor/react`, and it hands the
 *      loader the npm Monaco with `loader.config({ monaco })`. A second import
 *      site, or a dropped config call, quietly goes back to the CDN.
 *   2. Nothing in the web app names a CDN for Monaco.
 *   3. next.config.js swaps Monaco's vendored DOMPurify for the npm package. That
 *      rule matches Monaco's file by path, so a Monaco upgrade that moves or
 *      renames the file would leave it matching nothing. This reads the real files.
 */
const WEB = path.join(REPO_ROOT, 'apps/web')
const EDITOR = path.join(WEB_SRC, 'components/canvas/MonacoEditor.tsx')
const requireFromWeb = createRequire(path.join(WEB, 'package.json'))

const webSource = () => listFiles(WEB_SRC, { exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs'] })

/** Files that import a module by name, as `from 'x'`, `import('x')` or `require('x')`. */
export function importsOf(source: string, name: string): boolean {
  const q = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  return new RegExp(`(?:from\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*)['"]${q}['"]`).test(source)
}

/** Whether the editor module hands the loader the npm Monaco. */
export function configuresLocalMonaco(source: string): boolean {
  return /import\s+\*\s+as\s+monaco\s+from\s+['"]monaco-editor['"]/.test(source) && /loader\.config\(\s*\{\s*monaco\s*\}\s*\)/.test(source)
}

describe('Monaco is served from our own build (#2695)', () => {
  it('recognises the import and config shapes it guards', () => {
    expect(importsOf("import Editor, { loader } from '@monaco-editor/react'", '@monaco-editor/react')).toBe(true)
    expect(importsOf("const E = dynamic(() => import('@monaco-editor/react'))", '@monaco-editor/react')).toBe(true)
    expect(importsOf("import x from './MonacoEditor'", '@monaco-editor/react')).toBe(false)
    expect(configuresLocalMonaco("import * as monaco from 'monaco-editor'\nloader.config({ monaco })")).toBe(true)
    expect(configuresLocalMonaco("import * as monaco from 'monaco-editor'\nloader.config({ paths: { vs: 'x' } })")).toBe(false)
  })

  it('only MonacoEditor.tsx imports @monaco-editor/react, and it configures the local Monaco', () => {
    const files = webSource()
    expect(files.length, 'scanned no web source files').toBeGreaterThan(50)
    const importers = files.filter((f) => importsOf(sanitizeSource(readFileSync(f, 'utf8'), { blankStrings: false }), '@monaco-editor/react'))
    expect(importers.map((f) => path.relative(WEB_SRC, f))).toEqual([path.relative(WEB_SRC, EDITOR)])
    expect(configuresLocalMonaco(readFileSync(EDITOR, 'utf8')), 'MonacoEditor.tsx must call loader.config({ monaco }) with the npm Monaco').toBe(true)
  })

  it('no web source names a CDN for Monaco', () => {
    const offenders = webSource()
      .filter((f) => /cdn\.jsdelivr\.net|unpkg\.com\/monaco|cdnjs\.cloudflare\.com\/ajax\/libs\/monaco/.test(sanitizeSource(readFileSync(f, 'utf8'), { blankStrings: false })))
    expect(offenders.map((f) => path.relative(WEB_SRC, f))).toEqual([])
  })

  it("the DOMPurify swap matches Monaco's real import and points at the npm package", () => {
    const swap = requireFromWeb('./monaco-dompurify-swap.js') as {
      isMonacoVendoredDompurify: (request: string, context: string) => boolean
      npmDompurifyPath: (fromDir: string) => string
    }
    const monacoRoot = path.dirname(requireFromWeb.resolve('monaco-editor/package.json'))
    const sanitizeDir = path.join(monacoRoot, 'esm/vs/base/browser')
    const sanitize = readFileSync(path.join(sanitizeDir, 'domSanitize.js'), 'utf8')
    const imported = /import\s+\w+\s+from\s+['"](\.\/dompurify\/[^'"]+)['"]/.exec(sanitize)?.[1]
    expect(imported, "Monaco's domSanitize.js no longer imports a ./dompurify/ file; re-check the swap").toBeDefined()
    expect(existsSync(path.join(sanitizeDir, imported as string))).toBe(true)
    expect(swap.isMonacoVendoredDompurify(imported as string, sanitizeDir)).toBe(true)
    // A dompurify import from anywhere else is left alone.
    expect(swap.isMonacoVendoredDompurify(imported as string, path.join(WEB, 'src'))).toBe(false)
    const npm = swap.npmDompurifyPath(WEB)
    expect(readFileSync(npm, 'utf8')).toMatch(/export\s*\{\s*\w+\s+as\s+default\s*\}/)
    expect(readFileSync(path.join(WEB, 'next.config.js'), 'utf8')).toMatch(/NormalModuleReplacementPlugin\(VENDORED_REQUEST/)
  })
})
