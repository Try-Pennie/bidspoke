/**
 * Builds the one expression a session runs in Dan's logged in tab to preview,
 * apply or roll back a Main Flow port stage (#2171).
 *
 * Only a user of the production organization can PUT Main Flow, so the apply runs
 * in the browser as Dan, the way the Liberty1 workflow was created. The text is
 * transform.ts and apply.ts themselves, types stripped (Node's own
 * stripTypeScriptTypes, passed in), their imports and exports dropped, wrapped in
 * an async function that reads the Supabase session from the tab's cookies and calls
 * the chosen action. The token is read inside the tab and never printed or
 * returned. tab-bundle.test.ts evaluates the built text against a stand in tab.
 *
 * Pure: the caller reads the two files (scripts/main-flow-port-tab.ts).
 */
import type { PortStage } from './transform'
import type { VersionRef } from './apply'

export type TabArgs =
  | { action: 'preview' | 'apply'; stage: PortStage; workerUrl: string }
  | { action: 'rollback'; record: { before: VersionRef; after: VersionRef }; workerUrl: string }

export interface TabSources {
  transformSource: string
  applySource: string
  /** TypeScript to JavaScript by removing types only, as node:module's stripTypeScriptTypes does. */
  strip: (source: string) => string
  args: TabArgs
}

/**
 * Drops every import line (each file imports only the other, or types, which the
 * strip already blanked) and the `export` keyword. An import must sit on one line:
 * a multi line one is left in place and refused below rather than half removed.
 */
function asScriptBody(js: string): string {
  return js
    .replace(/^import [^\n]* from '[^'\n]+';?[ \t]*$/gm, '')
    .replace(/^export (?=(?:async )?function |const |class |let )/gm, '')
}

export function buildTabScript(sources: TabSources): string {
  const body = [asScriptBody(sources.strip(sources.transformSource)), asScriptBody(sources.strip(sources.applySource))].join('\n')
  const leftover = /^\s*(?:import|export)\b/m.exec(body)
  if (leftover) throw new Error(`the tab script would still hold an ${leftover[0].trim()} line, which a browser cannot run outside a module`)
  return [
    '(async () => {',
    body,
    `const __args = ${JSON.stringify(sources.args)};`,
    'const __token = accessTokenFromCookies(document.cookie);',
    "if (!__token) throw new Error('No Supabase session in this tab: open the Bidspoke app signed in as a member of the production organization, and run this there');",
    'const __api = httpWorkflowApi(__args.workerUrl, __token, (url, init) => fetch(url, init));',
    "if (__args.action === 'preview') return previewPort(__api, __args.stage);",
    "if (__args.action === 'apply') return applyPort(__api, __args.stage);",
    "if (__args.action === 'rollback') return rollbackPort(__api, __args.record);",
    "throw new Error('unknown action ' + __args.action);",
    '})()',
  ].join('\n')
}
