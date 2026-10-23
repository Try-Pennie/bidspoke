// @ts-check
/**
 * Monaco's ESM build carries its own copy of DOMPurify at
 * `monaco-editor/esm/vs/base/browser/dompurify/dompurify.js` (3.2.7 in Monaco
 * 0.55.1), imported by relative path from `domSanitize.js`, so the lockfile's
 * `dompurify` override never reaches it. next.config.js uses this module to point
 * that one import at the npm `dompurify` package instead, which the lockfile holds
 * at a patched release (GHSA-mrv2-3pqr-j5jr, #2695). Both export the same default
 * DOMPurify instance, and Monaco uses only its sanitize, addHook and
 * removeAllHooks.
 *
 * Kept apart from next.config.js so
 * `apps/web/src/lib/__tests__/monaco-self-hosted.test.ts` can check the rule
 * against the real Monaco files without loading the whole Next config.
 */
const path = require('node:path')
const fs = require('node:fs')

/** The import Monaco's `domSanitize.js` makes, as webpack sees the request. */
const VENDORED_REQUEST = /[\\/]dompurify[\\/]dompurify\.js$/

/** Whether a webpack request is Monaco's import of its own DOMPurify copy. */
function isMonacoVendoredDompurify(request, context) {
  return VENDORED_REQUEST.test(request ?? '') && /[\\/]monaco-editor[\\/]/.test(context ?? '')
}

/**
 * The npm package's ESM build, beside the CommonJS entry require.resolve finds.
 * A missing file stops the build rather than leaving Monaco's own copy in place.
 */
function npmDompurifyPath(fromDir) {
  const file = path.join(path.dirname(require.resolve('dompurify', { paths: [fromDir] })), 'purify.es.mjs')
  if (!fs.existsSync(file)) {
    throw new Error(`monaco-dompurify-swap: npm dompurify ESM build not found at ${file}`)
  }
  return file
}

module.exports = { VENDORED_REQUEST, isMonacoVendoredDompurify, npmDompurifyPath }
