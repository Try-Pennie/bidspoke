'use client'

/**
 * The canvas's code and JSON editor, served from our own build (#2695).
 *
 * `@monaco-editor/react` fetches Monaco from cdn.jsdelivr.net unless it is
 * handed a copy, and that CDN bundle carries its own DOMPurify 3.2.7, inside
 * GHSA-mrv2-3pqr-j5jr. Handing it the npm package through `loader.config`
 * makes Monaco part of our bundle, and next.config.js swaps Monaco's vendored
 * DOMPurify for the npm `dompurify` package the lockfile pins. It also removes
 * the runtime dependency on jsdelivr.
 *
 * Only ConfigPanel imports this file, and only through next/dynamic, so Monaco
 * downloads when a node's config panel opens on the canvas and never on any
 * other page. `apps/web/src/lib/__tests__/monaco-self-hosted.test.ts` fails if
 * the CDN loader comes back.
 */
import * as monaco from 'monaco-editor'
import Editor, { loader } from '@monaco-editor/react'

// Monaco runs its language services in web workers. Each `new Worker(new URL(...))`
// is bundled by webpack as its own chunk under /_next/static, served from this
// site like every other script.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') {
      return new Worker(new URL('monaco-editor/language/json/json.worker.js', import.meta.url))
    }
    if (label === 'typescript' || label === 'javascript') {
      return new Worker(new URL('monaco-editor/language/typescript/ts.worker.js', import.meta.url))
    }
    return new Worker(new URL('monaco-editor/editor/editor.worker.js', import.meta.url))
  },
}

loader.config({ monaco })

export default Editor
