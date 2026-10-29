/**
 * From one workflow of a Pipedream export to a draft (#1695, plan 9.1).
 *
 * The export is read through @bidspoke/porting-evidence's reader, never a second
 * one, and code is parsed with its one parser for step code (recast over
 * @babel/parser), never matched as text (#17). Nothing is written anywhere.
 *
 * In this slice the draft lists what the workflow holds; mapping each step to a
 * Bidspoke node is 9.2. What the converter cannot even read is named in
 * `unconverted`, never dropped: a code step that does not parse, a step of no
 * known shape, a trigger of no known type.
 */
import { isCodeStep, isControlFlowStep, parseStepCode, type PipedreamStep, type PipedreamWorkflow } from '@bidspoke/porting-evidence/instrument'
import { readExport, stateOf, type StoredRow } from '@bidspoke/porting-evidence/inventory'
import type { ConvertResult, Draft, DraftStep, DraftTrigger, PinnedComponent, Unconverted } from './draft.ts'
import { snapshotRefusal } from './snapshot.ts'

/** Trigger types the export holds (2026-09-30: http 241, timer 77, source 22, email 7). */
const KNOWN_TRIGGERS: readonly string[] = ['http', 'timer', 'email', 'source']

function pinned(uses: unknown): PinnedComponent | null {
  if (!uses || typeof uses !== 'object') return null
  const { key, version } = uses as { key?: unknown; version?: unknown }
  return typeof key === 'string' && typeof version === 'string' ? { key, version } : null
}

/** A parse error's message without anything but babel's own words and position. */
function parseFailure(e: unknown): string {
  const line = (e as { loc?: { line?: unknown } }).loc?.line
  const message = e instanceof Error ? e.message : 'the parser threw something that is not an error'
  return typeof line === 'number' ? `does not parse at line ${line}: ${message}` : `does not parse: ${message}`
}

function readStep(step: PipedreamStep, pipeline: string, unconverted: Unconverted[]): DraftStep {
  const where = `${pipeline}/${step.namespace}`
  const base = { pipeline, namespace: step.namespace, disabled: step.disabled === true }
  const unrecognised = (detail: string): DraftStep => {
    unconverted.push({ where, reason: 'unrecognised_step', detail })
    return { ...base, kind: 'unrecognised', uses: null, parsed: null }
  }
  const uses = (step as { uses?: unknown }).uses
  if (!uses || typeof uses !== 'object') {
    return unrecognised(typeof (step as { code_raw?: unknown }).code_raw === 'string' ? 'has no uses, only code_raw' : 'has no uses')
  }
  if (isControlFlowStep(step)) return { ...base, kind: 'control_flow', uses: null, parsed: null }
  if (step.uses.registry === true) {
    const component = pinned(uses)
    if (component === null) return unrecognised('a registry step without a key and version')
    return { ...base, kind: 'registry', uses: component, parsed: null }
  }
  if (!isCodeStep(step)) return unrecognised('neither code nor a registry component')

  // A private component carries its own key and version beside its code.
  const component = pinned(uses)
  let parsed = true
  try {
    parseStepCode(step.uses.code as string)
  } catch (e) {
    parsed = false
    unconverted.push({ where, reason: 'unparseable_code', detail: parseFailure(e) })
  }
  return { ...base, kind: component === null ? 'code' : 'private_component', uses: component, parsed }
}

function readTriggers(wf: PipedreamWorkflow, unconverted: Unconverted[]): DraftTrigger[] {
  return (wf.triggers ?? []).map((raw, index) => {
    const t = (raw ?? {}) as { type?: unknown; disabled?: unknown; uses?: unknown }
    const type = typeof t.type === 'string' ? t.type : ''
    if (!KNOWN_TRIGGERS.includes(type)) unconverted.push({ where: `trigger ${index}`, reason: 'unrecognised_trigger', detail: type === '' ? 'no type' : `type ${type}` })
    return { index, type, disabled: t.disabled === true, uses: pinned(t.uses) }
  })
}

/**
 * Drafts one workflow of the export in `dir`, given the workflow's inventory row
 * (null when it has none), which decides whether this export is the newest
 * recorded snapshot. Refuses by name rather than drafting from anything else.
 */
export function convertExport(dir: string, workflowId: string, stored: StoredRow | null): ConvertResult {
  const projects = readExport(dir)
  const project = projects.find((p) => p.workflows.some((w) => w.hashid === workflowId))
  const w = project?.workflows.find((x) => x.hashid === workflowId)
  if (!project || !w) return { ok: false, reason: 'workflow_not_in_export', message: `${workflowId} is not listed by any manifest in ${dir}` }
  if (w.workflow === null || w.sha256 === null || w.file === null) {
    return { ok: false, reason: 'never_deployed', message: `${workflowId} was never deployed, so the export holds no file to draft from` }
  }

  const refusal = snapshotRefusal(w, project.exportedAt, stored)
  if (refusal) return refusal

  const wf = w.workflow
  const unconverted: Unconverted[] = []
  const triggers = readTriggers(wf, unconverted)
  const steps: DraftStep[] = (wf.steps ?? []).map((s) => readStep(s, 'main', unconverted))
  for (const [deploymentId, deployment] of Object.entries(wf.deployments ?? {})) {
    for (const s of deployment.steps ?? []) steps.push(readStep(s, deploymentId, unconverted))
  }

  const draft: Draft = {
    workflow: { hashid: w.hashid, name: w.name, projectHashid: w.projectHashid, pipedreamState: stateOf(w) },
    snapshot: { sha256: w.sha256, exportedAt: project.exportedAt, file: w.file },
    triggers,
    steps,
    unconverted,
  }
  return { ok: true, draft }
}
