/**
 * The unlock table (#1710, plan 0.5): how many switched on Pipedream workflows
 * could move to Bidspoke after each capability lands, and the build order the data
 * gives. Re-run at each phase end, against the newest export.
 *
 *   node scripts/porting/unlock-table.ts <export dir> [--json]
 *
 * Reads the export and the porting decisions recorded in the inventory (#2979):
 * a retired workflow is left out, and a dropped step is taken out of its workflow
 * before its needs are read, so neither counts toward the table or the order.
 * Each is listed by name, and a dropped step this export does not hold is named
 * rather than silently leaving out nothing. Writes nothing. Prints the table in
 * the plan's order and in the order derived from the data, how many workflows
 * need each capability, and the workflows no capability unlocks. The rules behind
 * each need are in packages/porting-evidence/src/inventory/needs.ts, and they are
 * estimates until the later phases supply the real inputs.
 *
 * Credentials: as load-inventory.ts (credentials.ts), to read the decisions; a
 * failed read stops the script rather than counting retired workflows.
 * Runs on Node's own TypeScript type stripping (Node 23.6 or later).
 */
import {
  CAPABILITY_PHASE,
  PLAN_ORDER,
  applyDecisions,
  deriveOrder,
  readDecisions,
  readExport,
  unlockItems,
  unlockTable,
  type Capability,
} from '../../packages/porting-evidence/src/inventory/index.ts'
import { credentials, fail } from './credentials.ts'

const dir = process.argv[2]
if (!dir || dir.startsWith('--')) fail('usage: unlock-table.ts <export dir> [--json]')

const projects = readExport(dir)
const { url, key } = credentials()
const decided = applyDecisions(projects.flatMap((p) => p.workflows), await readDecisions(fetch, url, key))
const items = unlockItems(decided.workflows)

const needCounts = Object.fromEntries(PLAN_ORDER.map((c) => [c, items.filter((it) => it.needs.has(c)).length])) as Record<Capability, number>
const planTable = unlockTable(items, PLAN_ORDER)
const derived = deriveOrder(items)
const derivedTable = unlockTable(items, derived)
const times = projects.map((p) => p.exportedAt).sort()
const exportedAt = times[0] === times.at(-1) ? times[0] : `${times[0]} to ${times.at(-1)}`
const leftOut = { retired: decided.retired, droppedSteps: decided.dropped, droppedStepsNotInExport: decided.unmatched }

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ exportedAt, switchedOn: items.length, leftOut, needCounts, planOrder: planTable, planStillBlocked: planTable.stillBlocked, derivedOrder: derived, derivedTable }, null, 2)}\n`)
} else {
  const label = (c: Capability | null) => (c === null ? 'nothing new (today)' : CAPABILITY_PHASE[c])
  const print = (title: string, t: ReturnType<typeof unlockTable>) => {
    process.stdout.write(`\n${title}\n`)
    process.stdout.write('| Capability added (in this order) | All needs met | Of those, no redacted HTTP step | Bidding signals | _filter rules | Multi trigger | Timeout raised past 30 s |\n|---|---|---|---|---|---|---|\n')
    for (const r of t) process.stdout.write(`| ${label(r.added)} | ${r.unlocked} | ${r.unlockedNoRedacted} | ${r.bidding} | ${r.filterRules} | ${r.multiTrigger} | ${r.raisedTimeout} |\n`)
    if (t.stillBlocked.length > 0) process.stdout.write(`Still blocked after every capability: ${t.stillBlocked.join(', ')}\n`)
  }
  process.stdout.write(`Export of ${exportedAt}: ${projects.length} projects, ${items.length} switched on workflows counted.\n`)
  process.stdout.write(`Left out as retired: ${decided.retired.length}${decided.retired.map((r) => `\n  ${r.pipedream_hashid}, by ${r.retired_by}: ${r.retired_reason}`).join('')}\n`)
  process.stdout.write(`Steps dropped from their port: ${decided.dropped.length}${decided.dropped.map((d) => `\n  ${d.pipedream_hashid} step ${d.step}, by ${d.dropped_by}: ${d.reason}`).join('')}\n`)
  if (decided.unmatched.length > 0) {
    process.stdout.write(`DROPPED STEPS THIS EXPORT DOES NOT HOLD (nothing left out for them): ${decided.unmatched.map((d) => `${d.pipedream_hashid} step ${d.step}`).join(', ')}\n`)
  }
  process.stdout.write('\nWorkflows needing each capability:\n')
  for (const c of PLAN_ORDER) process.stdout.write(`  ${CAPABILITY_PHASE[c]}: ${needCounts[c]}\n`)
  print('In the plan order (Discussion #1684, 0.5):', planTable)
  print(`In the order derived from this export: ${derived.map((c) => CAPABILITY_PHASE[c].split(' ').slice(0, 2).join(' ')).join(', ')}`, derivedTable)
}
