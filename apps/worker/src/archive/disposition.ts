/**
 * What to do with one execution the archiver has read (#871, Phase A3).
 *
 * Three answers, and the differences between them are the point: archive it,
 * archive it as it stands and say so, or refuse it by id.
 */
import { SETTLE_WINDOW_MS } from './clock'

/**
 * The one organization that has ever produced an execution.
 *
 * Measured on prod 2026-08-20 (ADR 0009): the organization named `trypennie.com`
 * had 755,713 executions in the retained window and `E2E Test` had 0. That
 * measurement is what lets the archive skip a database-layer tenant boundary,
 * and it is a fact about today rather than a structural guarantee, because the
 * e2e org does create workflows. So the claim is ENFORCED here, where there is
 * real data to judge, instead of being asserted in a document nothing checks.
 *
 * This is the SLUG, and the distinction cost the whole archive. The value here
 * used to be `trypennie.com`, which is that organization's NAME; its slug is
 * `trypennie-com`. The comparison below is against `organization.slug`, so every
 * execution in production was refused as belonging to the wrong tenant, measured
 * at 5,617 of 5,617 in one hour. Both values look right to a reader, which is
 * precisely why a constant named for one column and populated from another is
 * invisible (L176). Both columns are recorded in fixtures/organizations.json and
 * __tests__/expected-organization.test.ts asserts this is the slug and is NOT
 * the name.
 */
export const EXPECTED_ORGANIZATION_SLUG = 'trypennie-com'

/**
 * How long past the settle window a non-terminal execution is refused before it
 * is archived as it stands instead.
 *
 * 24 hours, which puts the total at 26 hours from the execution's start, the
 * same point `finalize_unrecoverable_stranded` gives up. So a row this job
 * archives incomplete is one that job has already declared unrecoverable.
 *
 * The deadline exists because a strictly sequential watermark means one stuck
 * row does not block its own hour, it blocks every hour after it, permanently.
 * A wait with no deadline cannot fail, it can only hang (L110), and this
 * population is real and recurring.
 */
export const ARCHIVE_DEADLINE_MS = 24 * 60 * 60 * 1000

/** A workflow's owning organization: the id the archive stores, the slug it judges. */
export interface WorkflowOrganization {
  id: string
  slug: string
}

export interface Disposition {
  action: 'archive' | 'refuse'
  /** True when archived at the deadline while still non-terminal. */
  incomplete: boolean
  /** Present whenever the action is not a plain clean archive. */
  reason?: string
}

/**
 * How the archive reads one `workflow_executions.status` value.
 *
 * Three classes, not two, and the third is the point. The previous version of
 * this file matched a hand-written set of terminal statuses and let everything
 * else fall into "still running". That default is a legitimate outcome, so a
 * status nobody had accounted for was indistinguishable from one deliberately
 * treated as unfinished, and the set shipped wrong in both directions: it
 * claimed five values nothing has ever written and omitted `completed` and
 * `degraded`, which are 99.75% of production. Every execution was refused, the
 * shadow archive backed up close to nothing, and the hourly refusal alert said
 * so for as long as it ran (#929).
 *
 * `unrecognised` gives that case a name, so it is loud rather than silent.
 */
export type StatusClass = 'terminal' | 'in-flight' | 'unrecognised'

/**
 * The declared classification of every status the archive knows about.
 *
 * This is deliberately a declaration in code, not a set read out of the fixture
 * at runtime: a data file should not decide production branching, and a reader
 * should be able to see what each value means here. What keeps it honest is
 * `fixtures/execution-statuses.json`, an exhaustive measurement of what
 * `workflow_executions` actually holds, and the guard in
 * `__tests__/execution-status-vocabulary.test.ts` that fails when this map does
 * not account for every value in it (#930).
 *
 * `exited` has no rows in the retained window but is classified anyway: it is
 * named in the original CHECK constraint, is still in the `ExecutionStatus`
 * union, and is still counted by the stats route. An early Exit-node
 * termination is finished, not in flight.
 */
const STATUS_CLASSES: Record<string, Exclude<StatusClass, 'unrecognised'>> = {
  completed: 'terminal',
  failed: 'terminal',
  degraded: 'terminal',
  exited: 'terminal',
  running: 'in-flight',
}

export function classifyExecutionStatus(status: string): StatusClass {
  return STATUS_CLASSES[status] ?? 'unrecognised'
}

export function dispositionFor(
  execution: Record<string, unknown>,
  ctx: { now: Date; organizationOf: Map<string, WorkflowOrganization> },
): Disposition {
  const id = typeof execution.id === 'string' ? execution.id : '(no id)'
  const workflowId = typeof execution.workflow_id === 'string' ? execution.workflow_id : ''

  // Tenancy first, and deliberately ahead of the deadline: archiving another
  // tenant's data "as it stands" would be the exact outcome the refusal exists
  // to prevent, so the deadline must never be able to override it.
  const organization = ctx.organizationOf.get(workflowId)
  if (organization === undefined) {
    return {
      action: 'refuse',
      incomplete: false,
      reason: `execution ${id} belongs to workflow ${workflowId || '(none)'}, which maps to no organization`,
    }
  }
  if (organization.slug !== EXPECTED_ORGANIZATION_SLUG) {
    return {
      action: 'refuse',
      incomplete: false,
      reason:
        `execution ${id} belongs to organization ${organization.slug}, not ${EXPECTED_ORGANIZATION_SLUG}. ` +
        `The archive has no database-layer tenant boundary because only one organization has ever produced executions, ` +
        `and that is no longer true.`,
    }
  }

  const status = typeof execution.status === 'string' ? execution.status : ''
  const statusClass = classifyExecutionStatus(status)
  if (statusClass === 'terminal') {
    return { action: 'archive', incomplete: false }
  }

  const startedAt = typeof execution.started_at === 'string' ? Date.parse(execution.started_at) : NaN
  if (!Number.isFinite(startedAt)) {
    return {
      action: 'refuse',
      incomplete: false,
      reason: `execution ${id} has no readable started_at, so its deadline cannot be judged`,
    }
  }

  const age = ctx.now.getTime() - startedAt
  if (age >= SETTLE_WINDOW_MS + ARCHIVE_DEADLINE_MS) {
    return {
      action: 'archive',
      incomplete: true,
      reason:
        statusClass === 'unrecognised'
          ? `execution ${id} has the unrecognised status ${status || '(empty)'}, still unaccounted for at the archive deadline, so it is archived as it stands`
          : `execution ${id} is still ${status || 'non-terminal'} at the archive deadline, so it is archived as it stands`,
    }
  }

  // Distinct causes get distinct messages (L11). An ordinary in-flight run and
  // a status the archive has never been taught about are read the same way here
  // (both wait for the deadline) but they mean different things: the first
  // resolves itself, the second needs someone to classify it in STATUS_CLASSES.
  // Wording them identically is what hid #929 for as long as it hid.
  if (statusClass === 'unrecognised') {
    return {
      action: 'refuse',
      incomplete: false,
      reason:
        `execution ${id} has the unrecognised status ${status || '(empty)'}, which the archive does not classify as ` +
        `finished or in flight. Add it to STATUS_CLASSES in archive/disposition.ts and to the measured fixture beside it.`,
    }
  }

  return {
    action: 'refuse',
    incomplete: false,
    reason: `execution ${id} is still running and inside the archive deadline`,
  }
}
