/**
 * The unlock table (#1710, plan 0.5): how many switched on Pipedream workflows
 * could move to Bidspoke after each capability lands, and the build order the data
 * gives. Re-run at each phase end, against the newest export.
 *
 *   node scripts/porting/unlock-table.ts <export dir> [--json]
 *
 * Reads the export only; writes nothing and calls nothing. Prints the table in the
 * plan's order and in the order derived from the data, how many workflows need
 * each capability, and the workflows no capability unlocks. The rules behind each
 * need are in packages/porting-evidence/src/inventory/needs.ts, and they are
 * estimates until the later phases supply the real inputs.
 *
 * Runs on Node's own TypeScript type stripping (Node 23.6 or later).
 */
import {
  CAPABILITY_PHASE,
  PLAN_ORDER,
  deriveOrder,
  readExport,
  stateOf,
  unlockTable,
  workflowNeeds,
  type Capability,
  type UnlockItem,
} from '../../packages/porting-evidence/src/inventory/index.ts'

const dir = process.argv[2]
if (!dir || dir.startsWith('--')) {
  process.stderr.write('usage: unlock-table.ts <export dir> [--json]\n')
  process.exit(1)
}

const projects = readExport(dir)
const on = projects.flatMap((p) => p.workflows).filter((w) => stateOf(w) === 'on' && w.workflow !== null)
const items: UnlockItem[] = on.map((w) => {
  const n = workflowNeeds(w.workflow!)
  return {
    hashid: w.hashid,
    needs: new Set(n.needs.keys()),
    redactedHttpSteps: n.redactedHttpSteps,
    filterRules: n.filterRules,
    multiTrigger: n.multiTrigger,
    bidding: n.biddingSignals.length > 0,
    raisedTimeout: n.raisedTimeoutSeconds !== null,
  }
})

const needCounts = Object.fromEntries(PLAN_ORDER.map((c) => [c, items.filter((it) => it.needs.has(c)).length])) as Record<Capability, number>
const planTable = unlockTable(items, PLAN_ORDER)
const derived = deriveOrder(items)
const derivedTable = unlockTable(items, derived)
const times = projects.map((p) => p.exportedAt).sort()
const exportedAt = times[0] === times.at(-1) ? times[0] : `${times[0]} to ${times.at(-1)}`

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ exportedAt, switchedOn: items.length, needCounts, planOrder: planTable, planStillBlocked: planTable.stillBlocked, derivedOrder: derived, derivedTable }, null, 2)}\n`)
} else {
  const label = (c: Capability | null) => (c === null ? 'nothing new (today)' : CAPABILITY_PHASE[c])
  const print = (title: string, t: ReturnType<typeof unlockTable>) => {
    process.stdout.write(`\n${title}\n`)
    process.stdout.write('| Capability added (in this order) | All needs met | Of those, no redacted HTTP step | Bidding signals | _filter rules | Multi trigger | Timeout raised past 30 s |\n|---|---|---|---|---|---|---|\n')
    for (const r of t) process.stdout.write(`| ${label(r.added)} | ${r.unlocked} | ${r.unlockedNoRedacted} | ${r.bidding} | ${r.filterRules} | ${r.multiTrigger} | ${r.raisedTimeout} |\n`)
    if (t.stillBlocked.length > 0) process.stdout.write(`Still blocked after every capability: ${t.stillBlocked.join(', ')}\n`)
  }
  process.stdout.write(`Export of ${exportedAt}: ${projects.length} projects, ${items.length} switched on workflows.\n`)
  process.stdout.write('\nWorkflows needing each capability:\n')
  for (const c of PLAN_ORDER) process.stdout.write(`  ${CAPABILITY_PHASE[c]}: ${needCounts[c]}\n`)
  print('In the plan order (Discussion #1684, 0.5):', planTable)
  print(`In the order derived from this export: ${derived.map((c) => CAPABILITY_PHASE[c].split(' ').slice(0, 2).join(' ')).join(', ')}`, derivedTable)
}
