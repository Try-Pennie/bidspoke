/**
 * What to do with an execution the archive holds as INCOMPLETE (#871, #932).
 *
 * WHY THIS HAS TO EXIST. The deletion gate refuses any day carrying an incomplete
 * row, and both places that reason about that tolerance justify it by citing an
 * amend pass (`archive/gate.ts`, `lib/archive-gate.ts`). Nothing amended anything,
 * so an incomplete row was permanent: the day would be refused forever, its
 * partition could never be purged, and the alert would name a remedy that does not
 * exist. The gate fails safe, so this was a wedge rather than data loss, but it
 * wedges the one mechanism that stops the database growing.
 *
 * A row is archived incomplete only at the deadline in `disposition.ts`, 26 hours
 * from the execution's start, which is the same point `finalize_unrecoverable_stranded`
 * gives up. So the population is small and always abnormal: zero on all archived
 * days as of 2026-09-03, against a documented 1,094 row strand. It costs nothing
 * until the incident, and it is the incident that needs it.
 *
 * THREE ANSWERS, AND THE THIRD IS THE POINT. Amend it, wait for it, or write it
 * off. Without the third, a row that can never finalise leaves the day refused
 * forever just the same, so the wedge only moves. Writing off is therefore its own
 * action with its own reason, never folded into an amend, because a row corrected
 * and a row given up on are different events and every reader of the archive has
 * to be able to tell them apart (L11, L260).
 *
 * IT IS PURE. The IO half looks the executions up and rewrites the archive; this
 * decides, and takes the clock as an argument so a give-up test pins both ends of
 * the comparison instead of racing real time (L130).
 */

/**
 * Statuses that mean the execution is finished and its archived copy can be
 * corrected to match.
 *
 * `degraded` counts: it is a terminal outcome, not a stage. An unrecognised value
 * is deliberately NOT treated as running, see `amendDecisions`.
 */
export const TERMINAL_STATUSES = ['completed', 'failed', 'exited', 'degraded'] as const

/**
 * How long an incomplete row may keep being chased before it is written off.
 *
 * Measured from `archived_at`, not from the execution's start, because the start
 * is already 26 hours behind by the time a row is archived incomplete and the
 * question here is how long THIS pass keeps returning to it.
 *
 * Three days, matching the amend window's floor, which covers
 * `finalize-unrecoverable-stranded` at 08:30 and the half-hourly
 * `reduce_finalize_stranded`. A row those have not resolved in three days is not
 * going to resolve, and continuing to chase it is indistinguishable from having no
 * deadline at all (L110).
 */
export const AMEND_GIVE_UP_MS = 3 * 24 * 60 * 60 * 1000

/** An execution the archive holds as incomplete, from the local ledger. */
export interface ArchivedIncomplete {
  executionId: string
  archiveDay: string
  /** When the archiver wrote it, which is what the give-up window is measured from. */
  archivedAt: string
}

/** The same execution as Postgres currently has it. */
export interface LiveExecution {
  executionId: string
  status: string
  /**
   * Present for completeness, and deliberately NOT part of any wait condition.
   * Measured (fixtures/cost-settlement.json): for a failed execution an absent
   * cost is the settled final state, not a late arrival, so waiting on it would
   * chase about 5 rows a day forever and then alert about nothing (L36).
   */
  costUsd?: number | null
}

export interface AmendDecision {
  executionId: string
  archiveDay: string
  action: 'amend' | 'wait' | 'give-up'
  /** Always set for `wait` and `give-up`, so a record can say why (L11). */
  reason?: string
}

/**
 * One decision per archived-incomplete execution, in the order given.
 *
 * `live` is whatever Postgres still holds for them; an execution absent from it is
 * given up on regardless of age, because waiting cannot help once the source is
 * gone and the window exists to bound waiting rather than to delay an answer that
 * is already known.
 */
export function amendDecisions(
  archived: ArchivedIncomplete[],
  live: LiveExecution[],
  now: Date,
): AmendDecision[] {
  const byId = new Map(live.map((e) => [e.executionId, e]))

  return archived.map((row) => {
    const current = byId.get(row.executionId)
    const base = { executionId: row.executionId, archiveDay: row.archiveDay }

    if (current === undefined) {
      return {
        ...base,
        action: 'give-up' as const,
        reason:
          `execution ${row.executionId} is no longer in Postgres, so its archived copy can never be ` +
          `corrected from anywhere and the day would otherwise be refused forever`,
      }
    }

    if ((TERMINAL_STATUSES as readonly string[]).includes(current.status)) {
      return { ...base, action: 'amend' as const }
    }

    // Only `running` is a legitimate reason to come back. Anything else is a value
    // this code does not model, and treating an unknown as running would wait out
    // the whole window on every one before writing it off anyway, while treating it
    // as terminal would record a state nobody understands as final.
    if (current.status !== 'running') {
      return {
        ...base,
        action: 'give-up' as const,
        reason:
          `execution ${row.executionId} has status ${JSON.stringify(current.status)}, which is neither ` +
          `terminal nor running, so it cannot be judged finished or expected to change`,
      }
    }

    const age = now.getTime() - new Date(row.archivedAt).getTime()
    if (age >= AMEND_GIVE_UP_MS) {
      return {
        ...base,
        action: 'give-up' as const,
        reason:
          `execution ${row.executionId} is still non-terminal ${Math.floor(age / (60 * 60 * 1000))} hours ` +
          `after it was archived, past the ${AMEND_GIVE_UP_MS / (24 * 60 * 60 * 1000)} day amend window`,
      }
    }

    return {
      ...base,
      action: 'wait' as const,
      reason: `execution ${row.executionId} is still running, inside the amend window`,
    }
  })
}
