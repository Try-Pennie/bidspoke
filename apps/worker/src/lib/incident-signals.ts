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
 *  - `subject`: what the incident's subject key is (#2101), so a reader facing
 *    surface can name it rather than show a raw id. `workflow` when it starts
 *    with a Bidspoke workflow id (volume-cliff and slow-spike key on the id
 *    alone, failure-rate on `${id}:${match}`, the field presence tiers on
 *    `${id} ${fieldPath}`), `organization` when it is an organization id, and
 *    `name` when the key is itself readable (a host, a job name, a GitHub
 *    workflow file, a fixed id). Required, so a new signal must say.
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
export type IncidentSubjectKind = 'workflow' | 'organization' | 'name'

export interface IncidentSignalEntry {
  signal: string
  label: string
  scope: IncidentScopeKind
  subject: IncidentSubjectKind
  startMeans: string
  windowMinutes: number | 'per_call' | null
  kinds?: readonly string[]
}

const FIRST_PAGE = 'The first page that reached Slack.'
const FIRST_SEEN = 'When the condition was first seen, before any page.'

export const INCIDENT_SIGNALS = [
  { signal: 'failure-rate', label: 'Failure rate', scope: 'org', subject: 'workflow', startMeans: FIRST_PAGE, windowMinutes: 'per_call' },
  { signal: 'slow-spike', label: 'Slow execution', scope: 'org', subject: 'workflow', startMeans: FIRST_PAGE, windowMinutes: 5 },
  { signal: 'volume-cliff', label: 'Volume cliff', scope: 'org', subject: 'workflow', startMeans: FIRST_PAGE, windowMinutes: 4 },
  { signal: 'db-unreachable', label: 'Database unreachable', scope: 'org', subject: 'organization', startMeans: FIRST_PAGE, windowMinutes: null },
  { signal: 'field-presence-drought', label: 'Output field stopped', scope: 'org', subject: 'workflow', startMeans: FIRST_PAGE, windowMinutes: 60 },
  { signal: 'field-presence-dead', label: 'Output field not resolving', scope: 'org', subject: 'workflow', startMeans: FIRST_PAGE, windowMinutes: 7 * 1440 },
  { signal: 'field-presence-wrong-path', label: 'Output field path not found', scope: 'org', subject: 'workflow', startMeans: FIRST_PAGE, windowMinutes: 7 * 1440 },
  {
    signal: 'partner-reachability',
    label: 'Partner reachability',
    scope: 'platform',
    subject: 'name',
    startMeans: FIRST_SEEN,
    windowMinutes: null,
    kinds: ['blocked', 'unreachable', 'control-failing', 'probe-broken'],
  },
  {
    signal: 'supabase-memory',
    label: 'Database memory',
    scope: 'platform',
    subject: 'name',
    startMeans: FIRST_SEEN,
    windowMinutes: null,
    kinds: ['memory', 'feed'],
  },
  { signal: 'pg-cron-watch', label: 'Database job', scope: 'platform', subject: 'name', startMeans: FIRST_PAGE, windowMinutes: null },
  { signal: 'stored-copy-serving', label: 'Stored copy', scope: 'platform', subject: 'name', startMeans: FIRST_SEEN, windowMinutes: 5 },
  { signal: 'workflow-schedule', label: 'Scheduled workflow', scope: 'platform', subject: 'name', startMeans: FIRST_PAGE, windowMinutes: null },
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

/** What a reader sees for a stored signal the registry no longer (or never) named. */
export const UNRECOGNISED_SIGNAL_LABEL = 'Unrecognised signal'

/**
 * The reader's label for a stored signal string (#2101). A signal the registry
 * does not name (written by older code, or a retired check) is called what it
 * is, never given an invented label; the caller shows its raw key beside it.
 */
export function incidentSignalLabel(value: string): { label: string; known: boolean } {
  const entry = BY_SIGNAL.get(value)
  return entry ? { label: entry.label, known: true } : { label: UNRECOGNISED_SIGNAL_LABEL, known: false }
}

/** Why an incident ended. `lapsed` means its marker went away with no all-clear, so its end was never recorded. */
export const INCIDENT_END_REASONS = ['all_clear', 'stood_down_by_design', 'handed_over', 'lapsed'] as const
export type IncidentEndReason = (typeof INCIDENT_END_REASONS)[number]
