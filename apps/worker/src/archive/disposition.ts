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
 * Measured on prod 2026-08-20 (ADR 0009): `trypennie.com` had 755,713
 * executions in the retained window and `E2E Test` had 0. That measurement is
 * what lets the archive skip a database-layer tenant boundary, and it is a fact
 * about today rather than a structural guarantee, because the e2e org does
 * create workflows. So the claim is ENFORCED here, where there is real data to
 * judge, instead of being asserted in a document nothing checks.
 */
export const EXPECTED_ORGANIZATION_SLUG = 'trypennie.com'

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

const TERMINAL_STATUSES = new Set(['success', 'failed', 'error', 'rejected', 'exited', 'timeout', 'cancelled'])

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
  if (TERMINAL_STATUSES.has(status)) {
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
      reason: `execution ${id} is still ${status || 'non-terminal'} at the archive deadline, so it is archived as it stands`,
    }
  }

  return {
    action: 'refuse',
    incomplete: false,
    reason: `execution ${id} is still running and inside the archive deadline`,
  }
}
