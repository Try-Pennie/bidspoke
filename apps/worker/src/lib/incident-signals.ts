/**
 * Every signal the incident record can receive (#2099, #818).
 *
 * One entry per recovery prefix an alert arms through lib/alert-recovery.ts. The
 * recovery functions take `IncidentSignal`, so a check that arms a prefix this
 * list does not name fails to compile, and the record can never hold a signal
 * nothing describes.
 *
 * Each entry says:
 *  - `label`: what a reader calls it, taken from the words its all-clear already
 *    sends, so the record and Slack use one vocabulary (L118).
 *  - `scope`: whose it is. `org` signals are about one organization's workflows
 *    and every record of one carries that organization. `platform` signals are
 *    about something every organization shares (a partner host, the database,
 *    a scheduled job) and carry none. There is no default: a missing scope must
 *    never mean visible to everyone. The partner signals are platform even
 *    though a lead's organization reports them, because the host and its key
 *    are shared across organizations, and the probe reports as the literal org
 *    'probe', which is not an organization.
 *  - `startMeans`: what the incident's start time is, since the checks arm their
 *    marker at different moments.
 *  - `windowMinutes`: the trailing window the check judges, when its all-clear
 *    reports one (a one tick incident there is the window, not a zero span).
 *    `per_call` when each instance carries its own (failure-rate), null when the
 *    check judges a state rather than a window.
 *  - `kinds`: for a signal whose one prefix covers several problems or subjects,
 *    what they are.
 *
 * The windows are copied as numbers rather than imported, because the checks
 * import alert-recovery, which imports this file, and a constant read across
 * that cycle can be read before it exists. incident-signals.test.ts holds each
 * copy equal to its source.
 *
 * Note for anyone listing keys: database-memory claims its all-clear under
 * `supabase-memory-recovery-<id>` (a dash), which is not the recovery marker
 * `supabase-memory-recovery:<id>` (a colon). Read markers with a direct get of
 * recoveryKey(), never by listing a prefix.
 */

export type IncidentScopeKind = 'org' | 'platform'

export interface IncidentSignalEntry {
  signal: string
  label: string
  scope: IncidentScopeKind
  startMeans: string
  windowMinutes: number | 'per_call' | null
  kinds?: readonly string[]
}

const FIRST_PAGE = 'The first page that reached Slack.'
const FIRST_SEEN = 'When the condition was first seen, before any page.'

export const INCIDENT_SIGNALS = [
  { signal: 'failure-rate', label: 'Failure rate', scope: 'org', startMeans: FIRST_PAGE, windowMinutes: 'per_call' },
  { signal: 'slow-spike', label: 'Slow execution', scope: 'org', startMeans: FIRST_PAGE, windowMinutes: 5 },
  { signal: 'volume-cliff', label: 'Volume cliff', scope: 'org', startMeans: FIRST_PAGE, windowMinutes: 4 },
  { signal: 'db-unreachable', label: 'Database unreachable', scope: 'org', startMeans: FIRST_PAGE, windowMinutes: null },
  { signal: 'field-presence-drought', label: 'Output field stopped', scope: 'org', startMeans: FIRST_PAGE, windowMinutes: 60 },
  { signal: 'field-presence-dead', label: 'Output field not resolving', scope: 'org', startMeans: FIRST_PAGE, windowMinutes: 7 * 1440 },
  { signal: 'field-presence-wrong-path', label: 'Output field path not found', scope: 'org', startMeans: FIRST_PAGE, windowMinutes: 7 * 1440 },
  {
    signal: 'partner-reachability',
    label: 'Partner reachability',
    scope: 'platform',
    startMeans: FIRST_SEEN,
    windowMinutes: null,
    kinds: ['blocked', 'unreachable', 'control-failing', 'probe-broken'],
  },
  {
    signal: 'supabase-memory',
    label: 'Database memory',
    scope: 'platform',
    startMeans: FIRST_SEEN,
    windowMinutes: null,
    kinds: ['memory', 'feed'],
  },
  { signal: 'pg-cron-watch', label: 'Database job', scope: 'platform', startMeans: FIRST_PAGE, windowMinutes: null },
  { signal: 'stored-copy-serving', label: 'Stored copy', scope: 'platform', startMeans: FIRST_SEEN, windowMinutes: 5 },
  { signal: 'workflow-schedule', label: 'Scheduled workflow', scope: 'platform', startMeans: FIRST_PAGE, windowMinutes: null },
] as const satisfies readonly IncidentSignalEntry[]

export type IncidentSignal = (typeof INCIDENT_SIGNALS)[number]['signal']

const BY_SIGNAL: ReadonlyMap<string, IncidentSignalEntry> = new Map(INCIDENT_SIGNALS.map((s) => [s.signal, s]))

/** The registry entry for `signal`. */
export function incidentSignal(signal: IncidentSignal): IncidentSignalEntry {
  return BY_SIGNAL.get(signal)!
}

/** Whether a stored string names a registered signal (the drain reads events written by older code). */
export function isIncidentSignal(value: unknown): value is IncidentSignal {
  return typeof value === 'string' && BY_SIGNAL.has(value)
}

/** Why an incident ended. `lapsed` means its marker went away with no all-clear, so its end was never recorded. */
export const INCIDENT_END_REASONS = ['all_clear', 'stood_down_by_design', 'handed_over', 'lapsed'] as const
export type IncidentEndReason = (typeof INCIDENT_END_REASONS)[number]
