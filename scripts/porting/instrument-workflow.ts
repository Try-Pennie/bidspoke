/**
 * Instruments one exported Pipedream workflow for recording (#1705, plan 0.R).
 *
 *   node scripts/porting/instrument-workflow.ts <workflow.json> --receiver <base url> --out <dir>
 *   node scripts/porting/instrument-workflow.ts --survey <export dir>
 *
 * The first form writes three files into <dir>, which must be OUTSIDE the
 * repository (export contents are never committed):
 *   <hashid>.instrumented.json  the workflow with captures added, for review
 *   <hashid>.error-listener.js  the step for the $errors listener workflow
 *   <hashid>.report.json        every site instrumented and every site refused
 * and prints the refusals, each of which is a hand item. Nothing is sent to
 * Pipedream: Dan reviews the output and pastes it by hand.
 *
 * The second form instruments every workflow in an export in memory, writes
 * nothing, and prints the counts of sites instrumented and refused by kind.
 *
 * Runs on Node's own TypeScript type stripping (Node 23.6 or later).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  exportFiles,
  instrumentWorkflow,
  type InstrumentResult,
  type PipedreamWorkflow,
} from '../../packages/porting-evidence/src/instrument/index.ts'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function survey(dir: string) {
  const files = exportFiles(dir)
  if (files.length === 0) fail(`no workflow files under ${dir}`)
  const instrumented: Record<string, number> = {}
  const refused: Record<string, number> = {}
  let workflows = 0
  let delaySteps = 0
  for (const file of files) {
    const wf = JSON.parse(readFileSync(file, 'utf8')) as PipedreamWorkflow
    const result = instrumentWorkflow(wf, { receiverBaseUrl: 'https://ops.invalid' })
    workflows++
    delaySteps += result.delaySteps.length
    for (const s of result.sites) {
      const where = s.siteId.includes('/before:') ? ' before end-workflow' : s.siteId === 'main/end' ? ' at top level end' : ''
      const key = `${s.kind}${where} via ${s.how}`
      instrumented[key] = (instrumented[key] ?? 0) + 1
    }
    for (const r of result.refused) refused[r.reason] = (refused[r.reason] ?? 0) + 1
  }
  const total = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0)
  process.stdout.write(
    `${JSON.stringify({ workflows, delaySteps, instrumented, instrumentedTotal: total(instrumented), refused, refusedTotal: total(refused) }, null, 2)}\n`,
  )
}

function one(file: string, receiver: string, outDir: string) {
  const resolvedOut = path.resolve(outDir)
  if (resolvedOut === REPO_ROOT || resolvedOut.startsWith(REPO_ROOT + path.sep)) {
    fail(`refusing to write into the repository (${resolvedOut}): export contents are never committed`)
  }
  const wf = JSON.parse(readFileSync(file, 'utf8')) as PipedreamWorkflow
  const result: InstrumentResult = instrumentWorkflow(wf, { receiverBaseUrl: receiver })
  mkdirSync(resolvedOut, { recursive: true })
  const base = path.join(resolvedOut, wf.id)
  writeFileSync(`${base}.instrumented.json`, `${JSON.stringify(result.workflow, null, 2)}\n`)
  writeFileSync(`${base}.error-listener.js`, result.errorListener.code)
  writeFileSync(
    `${base}.report.json`,
    `${JSON.stringify({ sites: result.sites, refused: result.refused, delaySteps: result.delaySteps, errorListener: { trigger: result.errorListener.trigger, keyEnv: result.errorListener.keyEnv } }, null, 2)}\n`,
  )
  process.stdout.write(`${wf.id}: ${result.sites.length} sites instrumented, ${result.refused.length} refused\n`)
  for (const r of result.refused) process.stdout.write(`  REFUSED ${r.reason} at ${r.siteId} (line ${r.line}): instrument by hand\n`)
  process.stdout.write(`  key env var in Pipedream: ${result.errorListener.keyEnv}\n  wrote ${base}.*\n`)
}

const surveyDir = arg('--survey')
if (surveyDir) {
  survey(surveyDir)
} else {
  const file = process.argv[2]
  const receiver = arg('--receiver')
  const outDir = arg('--out')
  if (!file || file.startsWith('--') || !receiver || !outDir) {
    fail('usage: instrument-workflow.ts <workflow.json> --receiver <base url> --out <dir outside the repo>\n       instrument-workflow.ts --survey <export dir>')
  }
  one(file, receiver, outDir)
}
