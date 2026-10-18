/**
 * @bidspoke/service-catalogue/schema (#2337): the declarative entry point.
 *
 * Imported by the web canvas, the definition validator and the future MCP tool.
 * It must never reach the runtime entry, which holds `run` and the auth
 * functions: catalogue.test.ts walks this file's imports to prove it, and
 * apps/web's service-catalogue-runtime-stays-out-of-web.test.ts proves web
 * never imports runtime directly.
 */
export * from './types'
export * from './lookup'
export * from './google-delegation'
export { CATALOGUE } from './catalogue'
