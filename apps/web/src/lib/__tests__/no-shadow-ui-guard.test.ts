/**
 * #369: shadow mode was removed from the product UI. The engine machinery and its
 * own guard (shadow-side-effect-guard.ts) are intentionally retained as a reusable
 * dry-run capability, but the *frontend* surface (the Live/Shadow toggle, the
 * `shadow` request param, the shadow empty-state copy) is dead weight with no live
 * mirror source feeding it.
 *
 * This is the symmetric counterpart to shadow-side-effect-guard: that guard keeps
 * shadow machinery present in the engine; this one keeps shadow controls absent
 * from the web UI so the toggle can't quietly return.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = path.resolve(dir, '../../../../..')

// Files that previously carried the shadow-mode UI, mapped to the patterns that
// would indicate it has returned. The retained guard module is deliberately not
// scanned (it references shadow_mode/isShadowDryRun to protect the engine).
const CHECKS: { file: string; patterns: RegExp[] }[] = [
  {
    file: 'apps/web/src/components/canvas/ExecutionListPanel.tsx',
    patterns: [/setShadow/, /opts\.shadow/, /label:\s*'Shadow'/, /No shadow runs/i],
  },
  {
    file: 'apps/web/src/lib/api.ts',
    patterns: [/shadow\?:\s*boolean/, /set\('shadow'/],
  },
]

describe('no shadow-mode controls in the web UI (#369)', () => {
  it('the execution list and api client carry no shadow toggle or param', () => {
    const violations: string[] = []
    for (const { file, patterns } of CHECKS) {
      const src = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      src.split('\n').forEach((line, i) => {
        for (const re of patterns) {
          if (re.test(line)) violations.push(`  ${file}:${i + 1}  ${line.trim().slice(0, 100)}`)
        }
      })
    }
    expect(
      violations,
      `Shadow-mode UI found in the web app. Shadow mode was removed from the product ` +
        `(#369); the engine machinery is retained but the UI surface must stay gone:\n${violations.join('\n')}`,
    ).toEqual([])
  })
})
