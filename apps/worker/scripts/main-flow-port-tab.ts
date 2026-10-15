/**
 * Prints the expression to run in Dan's logged in Bidspoke tab to preview, apply
 * or roll back a stage of the Main Flow relay port (#2171, #1680 phases 4 to 7).
 * Nothing here calls the worker: the printed text does, as Dan, from his tab.
 * How and when to run it: docs/main-flow-relay-port.md.
 *
 *   npx tsx scripts/main-flow-port-tab.ts preview  <stage> <worker url>
 *   npx tsx scripts/main-flow-port-tab.ts apply    <stage> <worker url>
 *   npx tsx scripts/main-flow-port-tab.ts rollback <rollback record json file> <worker url>
 *
 * run from apps/worker. The stages are PORT_STAGES in
 * src/lib/main-flow-port/transform.ts; the rollback record is the `before` and
 * `after` an apply returned, saved as JSON.
 */
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTabScript, type TabArgs } from '../src/lib/main-flow-port/tab-bundle'
import { PORT_STAGES, type PortStage } from '../src/lib/main-flow-port/transform'

const here = dirname(fileURLToPath(import.meta.url))
const source = (file: string) => readFileSync(join(here, '..', 'src', 'lib', 'main-flow-port', file), 'utf8')

function argsFrom(argv: string[]): TabArgs {
  const [action, target, workerUrl] = argv
  if (!workerUrl || !/^https:\/\//.test(workerUrl)) throw new Error('the last argument is the worker URL, https://...')
  if (action === 'preview' || action === 'apply') {
    if (!(target in PORT_STAGES)) throw new Error(`unknown stage ${target}; one of ${Object.keys(PORT_STAGES).join(', ')}`)
    return { action, stage: target as PortStage, workerUrl }
  }
  if (action === 'rollback') {
    const record = JSON.parse(readFileSync(target, 'utf8')) as { before?: unknown; after?: unknown }
    if (!record.before || !record.after) throw new Error('the rollback record needs the before and after an apply returned')
    return { action, record: record as Extract<TabArgs, { action: 'rollback' }>['record'], workerUrl }
  }
  throw new Error('usage: preview|apply <stage> <worker url>, or rollback <record.json> <worker url>')
}

process.stdout.write(
  `${buildTabScript({ transformSource: source('transform.ts'), applySource: source('apply.ts'), strip: (s) => stripTypeScriptTypes(s), args: argsFrom(process.argv.slice(2)) })}\n`,
)
