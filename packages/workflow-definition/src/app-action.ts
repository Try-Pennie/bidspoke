/**
 * An app_action step at save (#2339): the same reading of its settings the ops
 * executor runs by (@bidspoke/service-catalogue/schema step-config.ts), so save
 * and run cannot disagree (L342), split by how each problem is enforced:
 *
 * - live_save (appActionConfigProblem, through validateNodeConfig): what a half
 *   built step lacks, in the setup order (action, version, connection, then a
 *   required argument), so a switched off draft can be saved part way.
 * - every_save (appActionSaveProblems): what no save may hold. A version the
 *   catalogue does not have, refused by name and never read as the newest (D1);
 *   an argument that version would refuse; a connection that is not a connection
 *   id, or an action of another service than the step names, never matched or
 *   replaced (L75).
 */
import {
  CATALOGUE, catalogueActions, readAppActionConfig, readStepArgs, resolveActionVersion, type AppActionConfigRefusal,
} from '@bidspoke/service-catalogue/schema'

const ACTIONS = catalogueActions(CATALOGUE)

/** What a half built step lacks: a draft may hold these, a live workflow may not. */
const SETUP_STEPS: ReadonlySet<AppActionConfigRefusal> = new Set(['action_not_chosen', 'action_version_not_pinned', 'connection_not_chosen'])

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

export interface AppActionProblem {
  reason: string
  message: string
}

/** The pinned version's schema, when the step names a version, or the refusal naming why it cannot be had. */
function pinned(config: Record<string, unknown>) {
  const { action, actionVersion } = config
  if (typeof action !== 'string' || typeof actionVersion !== 'number' || !Number.isInteger(actionVersion) || actionVersion < 1) return null
  return resolveActionVersion(ACTIONS, action, actionVersion)
}

/** The first thing a half built step lacks, for a live save, or null. */
export function appActionConfigProblem(config: Record<string, unknown>): string | null {
  const read = readAppActionConfig(config)
  if (!read.ok) return SETUP_STEPS.has(read.reason) ? read.message : null
  const resolved = pinned(config)
  if (resolved === null || !resolved.ok) return null
  const args = readStepArgs(resolved.action, read.config.args)
  const missing = args.ok ? undefined : args.problems.find((p) => p.reason === 'argument_missing')
  return missing ? missing.message : null
}

/** What no save of the step may hold, each by name. */
export function appActionSaveProblems(config: Record<string, unknown>): AppActionProblem[] {
  const out: AppActionProblem[] = []
  const read = readAppActionConfig(config)
  if (!read.ok && !SETUP_STEPS.has(read.reason)) out.push({ reason: read.reason, message: read.message })
  const resolved = pinned(config)
  if (resolved !== null) {
    if (!resolved.ok) {
      out.push({ reason: resolved.reason, message: resolved.message })
    } else if (isRecord(config.args) || config.args === undefined) {
      const args = readStepArgs(resolved.action, isRecord(config.args) ? config.args : {})
      if (!args.ok) {
        for (const p of args.problems) if (p.reason !== 'argument_missing') out.push({ reason: p.reason, message: p.message })
      }
    }
  }
  return out
}
