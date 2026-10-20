/**
 * Every signal the incident record can receive (#2099, #818).
 *
 * One entry per recovery prefix an alert arms through lib/alert-recovery.ts, and
 * one per alert that keeps its incident in its own state (the cron heartbeat,
 * #2103). The recovery functions take `RecoveryMarkerSignal`, so a check that
 * arms a prefix this list does not name fails to compile, and the record can
 * never hold a signal nothing describes.
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
 *    workflow file, a fixed id), and `connection` when it is an ops
 *    connection id (service_connections.id), whose delivering check always
 *    passes the connection's name and service as the incident's label (#2340).
 *    Required, so a new signal must say.
 *  - `kinds`: for a signal whose one prefix covers several problems or subjects,
 *    what they are.
 *  - `marker`: where the open incident's KV marker lives, for a signal that keeps
 *    it in its own state rather than alert-recovery's `<signal>-recovery:<id>`
 *    (#2103). The drain's lapse check reads it through incidentMarkerKey(), so
 *    an ongoing incident of such a signal is not closed as lapsed while its
 *    check still holds it open. Absent means the alert-recovery marker, whose
 *    value is the start itself. A signal with a marker cannot be passed to the
 *    alert-recovery functions (RecoveryMarkerSignal), which would arm a key the
 *    drain never reads.
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
export type IncidentSubjectKind = 'workflow' | 'organization' | 'name' | 'connection'

/**
 * A marker kept in a check's own state: the key is `${keyPrefix}${subject}${keySuffix}`
 * and its value is JSON, whose first field in `startFields` holding text is the
 * incident's start.
 */
export interface IncidentMarker {
  keyPrefix: string
  keySuffix: string
  startFields: readonly string[]
}

export interface IncidentSignalEntry {
  signal: string
  label: string
  scope: IncidentScopeKind
  subject: IncidentSubjectKind
  startMeans: string
  windowMinutes: number | 'per_call' | null
  kinds?: readonly string[]
  marker?: IncidentMarker
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
  // #2135. The partners page live channel, measured end to end every five
  // minutes through the synthetic monitor organization: `channel` when the
  // monitor's own notice did not arrive (the channel is broken for every
  // organization), `monitor` when the check could not run at all.
  {
    signal: 'partner-page-live',
    label: 'Partners page live updates',
    scope: 'platform',
    subject: 'name',
    startMeans: FIRST_SEEN,
    windowMinutes: null,
    kinds: ['channel', 'monitor'],
  },
  { signal: 'pg-cron-watch', label: 'Database job', scope: 'platform', subject: 'name', startMeans: FIRST_PAGE, windowMinutes: null },
  { signal: 'stored-copy-serving', label: 'Stored copy', scope: 'platform', subject: 'name', startMeans: FIRST_SEEN, windowMinutes: 5 },
  { signal: 'workflow-schedule', label: 'Scheduled workflow', scope: 'platform', subject: 'name', startMeans: FIRST_PAGE, windowMinutes: null },
  // #2103. A watched cron of the worker's own (cron-heartbeat.ts CRON_JOBS) gone
  // dark or never finishing: the same job for every organization, paged to every
  // Slack organization, keyed on the job id. Its open incident is the paged
  // status record the heartbeat already keeps (alertedStatusKey), which carries
  // the incident's start across a change of status; `at` is the page time a
  // record written before #2103 holds instead. incident-signals.test.ts holds the
  // key equal to alertedStatusKey().
  {
    signal: 'cron-heartbeat',
    label: 'Scheduled job',
    scope: 'platform',
    subject: 'name',
    startMeans: FIRST_PAGE,
    windowMinutes: null,
    marker: { keyPrefix: 'cron-heartbeat:', keySuffix: ':alerted-status', startFields: ['incidentStartedAt', 'at'] },
  },
  // #2103. An export job or scheduled check paging through notifyExportFailure
  // (export-alerts.ts): every one runs once for all organizations (one Snowflake
  // account, one database), pages every Slack organization, and keys its state on
  // the job name alone. It sends no all-clear: a clean run stands it down.
  {
    signal: 'export-alert',
    label: 'Export or scheduled check',
    scope: 'platform',
    subject: 'name',
    startMeans: FIRST_PAGE,
    windowMinutes: null,
  },
  // #468. Post-answer Salesforce writes waiting in outcome_writeback_deadletters
  // past their age, or a waiting count that grew between checks. Each row belongs
  // to one organization and only that organization can replay it, so it is that
  // organization's incident, keyed on its id. It judges a state, the backlog, so
  // it has no window. The label is the subject its all-clear names (slack.ts
  // WRITEBACK_BACKLOG_RECOVERY_SUBJECT).
  { signal: 'writeback-backlog', label: 'Failed Salesforce writes', scope: 'org', subject: 'organization', startMeans: FIRST_PAGE, windowMinutes: null },
  // #2331. An organization's sealed Slack bot token (service_connections.
  // credential_enc) that the minute database probe cannot open with the Worker's
  // key ring: `slack_token_undecryptable`, or `slack_key_ring_missing` for a
  // reader given no ring. One organization's row, keyed on its id. It judges a
  // state, so it has no window. Paged by slack-token-health.ts.
  {
    signal: 'slack-token-undecryptable',
    label: 'Slack token',
    scope: 'org',
    subject: 'organization',
    startMeans: FIRST_PAGE,
    windowMinutes: null,
    kinds: ['slack_token_undecryptable', 'slack_key_ring_missing'],
  },
  // #2340. An ops connection whose login needs a person: `needs_reauth` (a
  // person must reconnect it) or `refresh_failing` past Dan's decision 2 bound,
  // as the ops minute tick judged it. One organization's connection, keyed on
  // its id and labelled with its name and service. It judges a state, so it has
  // no window. Paged by ops-connection-logins.ts from the tick's report.
  {
    signal: 'ops-connection-login',
    label: 'Ops connection login',
    scope: 'org',
    subject: 'connection',
    startMeans: FIRST_PAGE,
    windowMinutes: null,
    kinds: ['needs_reauth', 'refresh_failing'],
  },
  // An ops person bound connection whose new login its ConnectionTokenObject
  // holds and service_connections has not taken for longer than the ops tick's
  // bound (#2340, phase 10 item 4), so the object holds the only copy. One
  // organization's connection, keyed on its id and labelled with its name and
  // service, apart from the login signal so neither silences the other. It
  // judges a state, so it has no window. Paged by ops-connection-logins.ts from
  // the judgement the tick's report carries.
  {
    signal: 'ops-connection-write-back',
    label: 'Ops connection login not saved',
    scope: 'org',
    subject: 'connection',
    startMeans: FIRST_PAGE,
    windowMinutes: null,
    kinds: ['write_back_pending'],
  },
] as const satisfies readonly IncidentSignalEntry[]

export type IncidentSignal = (typeof INCIDENT_SIGNALS)[number]['signal']

/** The signals whose open incident is alert-recovery's marker: the only ones the alert-recovery functions accept. */
export type RecoveryMarkerSignal = Exclude<(typeof INCIDENT_SIGNALS)[number], { marker: IncidentMarker }>['signal']

const BY_SIGNAL: ReadonlyMap<string, IncidentSignalEntry> = new Map(INCIDENT_SIGNALS.map((s) => [s.signal, s]))

/** The registry entry for `signal`. */
export function incidentSignal(signal: IncidentSignal): IncidentSignalEntry {
  return BY_SIGNAL.get(signal)!
}

/**
 * The KV key holding `subject`'s open incident marker for `signal` (#2103): the
 * signal's own marker when the registry names one, otherwise alert-recovery's
 * `<signal>-recovery:<subject>` (recoveryKey, which incident-signals.test.ts
 * holds equal to this).
 */
export function incidentMarkerKey(signal: IncidentSignal, subject: string): string {
  const marker = BY_SIGNAL.get(signal)?.marker
  return marker ? `${marker.keyPrefix}${subject}${marker.keySuffix}` : `${signal}-recovery:${subject}`
}

/**
 * The incident start a marker's value holds, or null when it holds none that can
 * be read. Never a guess: a reader treats null as a marker present with an
 * unknown start.
 */
export function incidentMarkerStart(signal: IncidentSignal, raw: string): string | null {
  const marker = BY_SIGNAL.get(signal)?.marker
  if (!marker) return raw
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    for (const field of marker.startFields) {
      const v = (parsed as Record<string, unknown>)[field]
      if (typeof v === 'string') return v
    }
    return null
  } catch {
    return null
  }
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
