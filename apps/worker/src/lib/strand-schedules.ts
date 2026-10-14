/**
 * The pg_cron schedules of the three jobs that finalize stranded lead sightings,
 * as the drain stall alert in slack.ts quotes them (#835). The alert used to name
 * "08:00 + 08:30 UTC daily drains", a schedule that had changed twice since.
 *
 * A leaf module (no imports) so the web guard drain-stall-schedules-match-cron
 * can import the object itself and compare each entry with the schedule the
 * migrations leave the job on, rather than parsing slack.ts as text.
 */
export const DRAIN_STALL_SCHEDULES = {
  // The shallow 1 day pass, recoverable strands only.
  'reduce-finalize-stranded': '27,57 * * * *',
  // The daily deep 8 day pass, the same function.
  'reduce-finalize-stranded-deep': '45 7 * * *',
  // Finalizes EVERY sighting older than 26 hours, recoverable or not.
  'finalize-unrecoverable-stranded': '30 8 * * *',
} as const
