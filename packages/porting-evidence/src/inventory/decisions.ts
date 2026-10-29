/**
 * A person's porting decisions (#2979): a Pipedream workflow that will not be
 * ported (retired), and a step left out of a port (dropped). Dan makes both as he
 * ports; nothing here decides one.
 *
 * Stored in porting.pipedream_inventory (porting_stage 'retired' with retired_by,
 * retired_reason and retired_at, all set exactly when retired) and in
 * porting.dropped_steps (one row per step, with who, why and when). The loader
 * never writes either (BIDSPOKE_OWNED_COLUMNS), so a reload keeps them.
 *
 * Pure: applyDecisions takes an export and the stored decisions and returns the
 * export the unlock table should count, and planDecision checks one requested
 * decision against what is stored and returns the write it needs, refusing by
 * name anything it cannot stand behind. record.ts does the reading and writing.
 */
import type { PipedreamStep, PipedreamWorkflow } from '../instrument/instrument.ts'
import { allSteps } from './needs.ts'
import type { ExportedWorkflow } from './read-export.ts'

export interface Retirement { pipedream_hashid: string; retired_by: string; retired_reason: string; retired_at: string }
export interface DroppedStep { pipedream_hashid: string; step: string; dropped_by: string; reason: string; dropped_at: string }
export interface Decisions { retired: Retirement[]; dropped: DroppedStep[] }

export interface DecidedExport {
  /** The export without its retired workflows, and with each dropped step taken out of its workflow. */
  workflows: ExportedWorkflow[]
  /** The retirements of workflows this export holds, which it left out. */
  retired: Retirement[]
  /** The dropped steps it found and took out. */
  dropped: DroppedStep[]
  /** Dropped steps naming a workflow or step this export does not hold, so nothing was left out for them. */
  unmatched: DroppedStep[]
}

/** Every step's namespace, top level and in every deployment branch. */
export function stepNamespaces(wf: PipedreamWorkflow): string[] {
  return allSteps(wf).map((s) => s.namespace)
}

function withoutSteps(wf: PipedreamWorkflow, drop: ReadonlySet<string>): PipedreamWorkflow {
  const keep = (steps: PipedreamStep[] | undefined) => steps?.filter((s) => !drop.has(s.namespace))
  const deployments = wf.deployments === undefined
    ? undefined
    : Object.fromEntries(Object.entries(wf.deployments).map(([k, d]) => [k, { ...d, steps: keep(d.steps) }]))
  return { ...wf, steps: keep(wf.steps) ?? [], ...(deployments === undefined ? {} : { deployments }) }
}

const byKey = (a: DroppedStep, b: DroppedStep) => `${a.pipedream_hashid}\u0000${a.step}`.localeCompare(`${b.pipedream_hashid}\u0000${b.step}`)

export function applyDecisions(workflows: ExportedWorkflow[], decisions: Decisions): DecidedExport {
  const retiredBy = new Map(decisions.retired.map((r) => [r.pipedream_hashid, r]))
  const dropsBy = new Map<string, DroppedStep[]>()
  for (const d of decisions.dropped) dropsBy.set(d.pipedream_hashid, [...(dropsBy.get(d.pipedream_hashid) ?? []), d])

  const out: DecidedExport = { workflows: [], retired: [], dropped: [], unmatched: [] }
  const seen = new Set<string>()
  for (const w of workflows) {
    seen.add(w.hashid)
    const retired = retiredBy.get(w.hashid)
    if (retired) { out.retired.push(retired); continue }
    const drops = dropsBy.get(w.hashid) ?? []
    if (drops.length === 0 || w.workflow === null) {
      out.unmatched.push(...drops)
      out.workflows.push(w)
      continue
    }
    const held = new Set(stepNamespaces(w.workflow))
    const found = drops.filter((d) => held.has(d.step))
    out.dropped.push(...found)
    out.unmatched.push(...drops.filter((d) => !held.has(d.step)))
    out.workflows.push({ ...w, workflow: withoutSteps(w.workflow, new Set(found.map((d) => d.step))) })
  }
  // A drop of a workflow this export does not hold left nothing out. A drop of a
  // retired workflow is moot: the whole workflow is left out.
  for (const [hashid, drops] of dropsBy) if (!seen.has(hashid)) out.unmatched.push(...drops)

  out.retired.sort((a, b) => a.pipedream_hashid.localeCompare(b.pipedream_hashid))
  out.dropped.sort(byKey)
  out.unmatched.sort(byKey)
  return out
}

export type DecisionRequest =
  | { kind: 'retire'; hashid: string; by: string; reason: string }
  | { kind: 'unretire'; hashid: string }
  | { kind: 'drop_step'; hashid: string; step: string; by: string; reason: string }
  | { kind: 'keep_step'; hashid: string; step: string }

/** What is stored for the workflow a decision names, read just before planning it. */
export interface DecisionTarget {
  /** Its inventory row, or null when the inventory does not hold it. */
  row: { pipedream_hashid: string; name: string; porting_stage: string; retired_by: string | null; retired_reason: string | null; retired_at: string | null } | null
  /** Its steps already dropped. */
  dropped: DroppedStep[]
}

export type DecisionWrite =
  | { kind: 'retire'; hashid: string; set: { porting_stage: 'retired'; retired_by: string; retired_reason: string; retired_at: string } }
  | { kind: 'unretire'; hashid: string }
  | { kind: 'drop_step'; row: DroppedStep }
  | { kind: 'keep_step'; hashid: string; step: string }

export interface DecisionPlan { describe: string; write: DecisionWrite }

const said = (value: string, what: string): string => {
  const v = value.trim()
  if (v === '') throw new Error(`${what} is required`)
  return v
}

/**
 * The write one requested decision needs, given what is stored now. exportSteps
 * is the workflow's step namespaces in the export the person names, needed only
 * to drop a step, so a misspelt step is refused rather than recorded (L100).
 */
export function planDecision(req: DecisionRequest, target: DecisionTarget, exportSteps: string[] | null, now: string): DecisionPlan {
  const row = target.row
  if (row === null) throw new Error(`${req.hashid} is not in porting.pipedream_inventory; load the export that lists it first`)
  const name = `${req.hashid} (${row.name})`

  switch (req.kind) {
    case 'retire': {
      const by = said(req.by, '--by, who decided,')
      const reason = said(req.reason, '--reason, why it will not be ported,')
      if (row.porting_stage === 'retired') throw new Error(`${name} is already retired by ${row.retired_by ?? 'nobody recorded'} (${row.retired_reason ?? 'no reason recorded'})`)
      if (row.porting_stage !== 'none') throw new Error(`${name} is at porting stage ${row.porting_stage}; only a workflow not yet ported (none) can be retired`)
      return {
        describe: `Retire ${name}: will not be ported. Decided by ${by}, because: ${reason}. Recorded at ${now}.`,
        write: { kind: 'retire', hashid: req.hashid, set: { porting_stage: 'retired', retired_by: by, retired_reason: reason, retired_at: now } },
      }
    }
    case 'unretire':
      if (row.porting_stage !== 'retired') throw new Error(`${name} is not retired (its porting stage is ${row.porting_stage})`)
      return { describe: `Undo the retirement of ${name} (by ${row.retired_by ?? 'nobody recorded'}: ${row.retired_reason ?? 'no reason recorded'}); its porting stage goes back to none.`, write: { kind: 'unretire', hashid: req.hashid } }
    case 'drop_step': {
      const by = said(req.by, '--by, who decided,')
      const reason = said(req.reason, '--reason, why the step is left out,')
      if (exportSteps === null) throw new Error(`${req.hashid} is not in the export given, or has no workflow file there, so step ${req.step} cannot be checked`)
      if (!exportSteps.includes(req.step)) throw new Error(`${req.step} is not a step of ${name} in the export given; its steps are ${exportSteps.join(', ') || 'none'}`)
      const already = target.dropped.find((d) => d.step === req.step)
      if (already) throw new Error(`step ${req.step} of ${name} is already dropped by ${already.dropped_by} (${already.reason})`)
      return {
        describe: `Drop step ${req.step} from the port of ${name}. Decided by ${by}, because: ${reason}. Recorded at ${now}.`,
        write: { kind: 'drop_step', row: { pipedream_hashid: req.hashid, step: req.step, dropped_by: by, reason, dropped_at: now } },
      }
    }
    case 'keep_step': {
      const dropped = target.dropped.find((d) => d.step === req.step)
      if (!dropped) throw new Error(`step ${req.step} of ${name} is not dropped`)
      return { describe: `Keep step ${req.step} of ${name} in its port again (dropped by ${dropped.dropped_by}: ${dropped.reason}).`, write: { kind: 'keep_step', hashid: req.hashid, step: req.step } }
    }
  }
}

/** Every way the stored state differs from what a written decision should have left. Empty means it landed. */
export function decisionDifferences(write: DecisionWrite, after: DecisionTarget): string[] {
  const row = after.row
  if (row === null) return ['the inventory row is gone']
  const sameTime = (a: string | null, b: string) => a !== null && Date.parse(a) === Date.parse(b)
  switch (write.kind) {
    case 'retire': {
      const s = write.set
      const out: string[] = []
      if (row.porting_stage !== 'retired') out.push(`porting_stage is ${row.porting_stage}, not retired`)
      if (row.retired_by !== s.retired_by) out.push(`retired_by is ${JSON.stringify(row.retired_by)}`)
      if (row.retired_reason !== s.retired_reason) out.push(`retired_reason is ${JSON.stringify(row.retired_reason)}`)
      if (!sameTime(row.retired_at, s.retired_at)) out.push(`retired_at is ${JSON.stringify(row.retired_at)}`)
      return out
    }
    case 'unretire':
      return row.porting_stage === 'none' && row.retired_by === null && row.retired_reason === null && row.retired_at === null
        ? []
        : [`porting_stage is ${row.porting_stage} with retired_by ${JSON.stringify(row.retired_by)}`]
    case 'drop_step': {
      const d = after.dropped.find((x) => x.step === write.row.step)
      if (!d) return [`step ${write.row.step} is not stored as dropped`]
      return d.dropped_by === write.row.dropped_by && d.reason === write.row.reason && sameTime(d.dropped_at, write.row.dropped_at) ? [] : [`step ${write.row.step} is stored as ${JSON.stringify(d)}`]
    }
    case 'keep_step':
      return after.dropped.some((x) => x.step === write.step) ? [`step ${write.step} is still stored as dropped`] : []
  }
}
