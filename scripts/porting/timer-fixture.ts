/**
 * The schedule converter's fixture (#1952): every timer trigger in a Pipedream
 * export, as JSON on stdout.
 *
 *   node scripts/porting/timer-fixture.ts <export dir> > packages/workflow-definition/src/schedule/fixtures/pipedream-timers.json
 *
 * Reads the export only; writes nothing and calls nothing. Each record carries
 * the workflow hashid, the trigger's index, whether the workflow is switched on,
 * whether the trigger is disabled, and the timer's props verbatim (cron or
 * interval, and zone), never a name or any step. The converter's test
 * (pipedream-timer.test.ts) runs over every record, so regenerating it against a
 * newer export is how a cron shape that export introduces gets measured.
 *
 * Runs on Node's own TypeScript type stripping (Node 23.6 or later).
 */
import { readExport, timerTriggers } from '../../packages/porting-evidence/src/inventory/index.ts'

const dir = process.argv[2]
if (!dir || dir.startsWith('--')) {
  process.stderr.write('usage: timer-fixture.ts <export dir>\n')
  process.exit(1)
}

const projects = readExport(dir)
const times = projects.map((p) => p.exportedAt).sort()
const exportedAt = times[0] === times.at(-1) ? times[0] : `${times[0]} to ${times.at(-1)}`
const timers = timerTriggers(projects)
process.stdout.write(`${JSON.stringify({ exported_at: exportedAt, generated_by: 'node scripts/porting/timer-fixture.ts <export dir>', timers }, null, 2)}\n`)
