/**
 * #273 category 2: the app's confirm modals are hand-rolled divs, so they must
 * carry dialog semantics (role="dialog" + aria-modal + an accessible name via
 * aria-labelledby) for screen readers to announce them. This guard locks those
 * attributes in so a future edit can't quietly drop them. Focus-trapping is a
 * separate concern tracked in #49.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = path.resolve(dir, '../../../../..')

// Each modal file must contain a dialog container with all three attributes.
const MODAL_FILES = [
  'apps/web/src/components/canvas/RenameConfirmDialog.tsx',
  'apps/web/src/components/canvas/WorkflowCanvas.tsx', // container-delete confirm dialog
]

describe('confirm modals carry dialog semantics (#273)', () => {
  it.each(MODAL_FILES)('%s has role=dialog, aria-modal, and aria-labelledby', (rel) => {
    const src = readFileSync(path.join(REPO_ROOT, rel), 'utf8')
    expect(src, `${rel} is missing role="dialog"`).toMatch(/role="dialog"/)
    expect(src, `${rel} is missing aria-modal`).toMatch(/aria-modal="true"/)
    expect(src, `${rel} is missing aria-labelledby`).toMatch(/aria-labelledby=/)
  })
})
