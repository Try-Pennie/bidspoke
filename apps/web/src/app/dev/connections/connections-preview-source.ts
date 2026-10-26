/**
 * The development preview's data for the Connections page (#2338, build PRs 9 and 10):
 * the settled design's own fixture (docs/design/connections-page.fixture.json),
 * turned into what the Worker's routes answer, so the page draws exactly what
 * the design's frames draw and the design score can compare the two. No
 * network: every call is answered here. Not served in a production build.
 */
import type { ConnectionList, ConnectionListRow } from '@/lib/api'
import fixture from '../../../../../../docs/design/connections-page.fixture.json'
import googleReturn from '../../../../../../docs/design/google-sign-in-return.fixture.json'
import { FINISHING_LABEL } from '@/components/connections/google-sign-in-return'
import { loadedOf, type ConnectionsSource } from '@/components/connections/ConnectionsScreen'
import { keptSignInsIn } from '@/components/connections/google-sign-in-kept'
import { CHANGE_DEADLINES, LIST_NO_ANSWER, type Chosen, type ConnectionsEvent } from '@/components/connections/connections-state'
import type { DelegationEntry, HistoryEntry } from '@/components/connections/connection-model'
import { catalogueServices, createdView, stalledSentence, type FormService } from '@/components/connections/add-form-model'
import { alertSettingsOf, channelFailed, switchFailed, type AlertSettings } from '@/components/connections/alert-settings-model'

/** The moment every frame is drawn at: 12:00 PM ET on the day the design was settled. */
export const PREVIEW_NOW = Date.parse('2026-10-20T16:00:00Z')

type FixtureConnection = (typeof fixture.connections)[number] & {
  workflows?: string[]
  history?: string[][]
  since?: string
  instance?: string
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
/** A fixture id, shaped as a uuid so it reads as one. */
const idOf = (name: string) => `0000${slug(name)}`.padEnd(12, '0')

/** "4 min ago", "2 hours ago", "just now" back into a moment before PREVIEW_NOW. */
function agoToIso(ago: string): string {
  const m = /^(\d+) (min|hours?) ago$/.exec(ago)
  if (!m) return new Date(PREVIEW_NOW).toISOString()
  const ms = Number(m[1]) * (m[2] === 'min' ? 60_000 : 3_600_000)
  return new Date(PREVIEW_NOW - ms).toISOString()
}

/** "9:52 AM ET" on the preview's day, in EDT (UTC minus 4). */
function etTodayToIso(clock: string): string {
  const m = /^(\d{1,2}):(\d{2}) (AM|PM) ET$/.exec(clock)
  if (!m) throw new Error(`the fixture time ${clock} is not "h:mm AM ET"`)
  const hour = (Number(m[1]) % 12) + (m[3] === 'PM' ? 12 : 0)
  return new Date(Date.UTC(2026, 9, 20, hour + 4, Number(m[2]))).toISOString()
}

/** "Oct 18" and "2:14 PM" back into a moment, in EDT. */
function etDayTimeToIso(day: string, clock: string): string {
  const d = /^Oct (\d{1,2})$/.exec(day)
  const t = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(clock)
  if (!d || !t) throw new Error(`the fixture moment ${day} ${clock} is not "Oct d" and "h:mm AM"`)
  const hour = (Number(t[1]) % 12) + (t[3] === 'PM' ? 12 : 0)
  return new Date(Date.UTC(2026, 9, Number(d[1]), hour + 4, Number(t[2]))).toISOString()
}

/** A Salesforce connection's client id: Achieve's is the design's own (its Reconnect frame shows it kept). */
function clientIdOf(name: string): string {
  return name.startsWith('Achieve Salesforce') ? fixture.reconnect.clientId : `client-id-of-${slug(name)}`
}

function rowOf(c: FixtureConnection): ConnectionListRow {
  const checked = agoToIso(c.checked)
  const status = c.status as ConnectionListRow['status']
  const names = c.workflows ?? Array.from({ length: c.usedBy }, (_, i) => `${c.name} workflow ${i + 1}`)
  const opsStatus = status === 'reauth' ? 'needs_reauth' : status === 'failing' ? 'check_failing' : 'healthy'
  const alert = c.name === 'Bidspoke Alerts'
  return {
    id: idOf(c.name),
    name: c.name,
    service: slug(c.service),
    service_name: c.service,
    alert_login: alert,
    // An OpenAI key acts in its project and an Anthropic key in its workspace, as the create route words them (#2337): neither names more than an id to a key.
    acts_as: c.service === 'OpenAI' ? 'Project proj_bidspoke_ops in pennie' : c.service === 'Anthropic' ? 'Workspace wrkspc_ops' : c.actsAs,
    person_bound: c.kind === 'person',
    owner: null,
    // An ops Slack bot declares its workspace, an OpenAI key its project and an Anthropic key its workspace (#2337); the alert login declares nothing.
    target: c.instance
      ? { instance_url: `https://${c.instance}`, client_id: clientIdOf(c.name) }
      : c.service === 'Slack' && !alert ? { team_id: 'T0PENNIE' }
        : c.service === 'OpenAI' ? { project_id: 'proj_bidspoke_ops' }
          : c.service === 'Anthropic' ? { workspace_id: 'wrkspc_ops' }
            // A Google connection declares the mailbox it acts as, which verify read back (#2337).
            : c.service === 'Google' && c.actsAs ? { subject: c.actsAs } : null,
    org: c.instance ?? null,
    status,
    status_word: fixture.statusVocabulary[c.status as keyof typeof fixture.statusVocabulary] ?? null,
    health: alert ? null : {
      ops_status: opsStatus,
      last_check_ok_at: status === 'ok' ? checked : null,
      last_check_failed_at: status === 'ok' ? null : checked,
      last_check_cause: status === 'failing' ? 'check_failed' : status === 'reauth' ? 'login_refused: invalid_client' : null,
      needs_reauth_at: status === 'reauth' && c.since ? etTodayToIso(c.since) : null,
      needs_reauth_cause: status === 'reauth' ? 'login_refused: invalid_client' : null,
    },
    checked_at: checked,
    used_by: names.length,
    workflows: names.map((name) => ({ id: idOf(name), name, deleted: false })),
    created_at: checked,
    updated_at: checked,
  }
}

/** The frames loaded through the page's own calls, and what each chooses. The add, dialog and saved frames are drawn by their events (previewScript). */
export function previewFrame(frame: string | undefined): { list: 'loaded' | 'stale' | 'failed' | 'loading'; chosen: Chosen } {
  const chosen = (name: string): Chosen => ({ kind: 'connection', id: idOf(name) })
  switch (frame) {
    case 'problem':
      return { list: 'loaded', chosen: chosen('Achieve Salesforce') }
    case 'google-list':
      return { list: 'loaded', chosen: { kind: 'google' } }
    case 'stale':
      return { list: 'stale', chosen: chosen('Pennie Salesforce') }
    case 'not-loaded':
      return { list: 'failed', chosen: { kind: 'none' } }
    default:
      return { list: 'loaded', chosen: chosen('Pennie Salesforce') }
  }
}

/**
 * The services the form offers in the preview: the design's eight tiles, in its
 * order (D12). Anthropic, Google, OpenAI, Salesforce, Slack and Snowflake are
 * the catalogue's own entries (Google's since #2337); the other two are drawn
 * so the grid holds the design's tiles, each with one secret field, and are
 * never offered by the live page.
 */
export function previewServices(): FormService[] {
  const shipped = new Map(catalogueServices().map((s) => [s.name, s]))
  return fixture.services.map(([name, tile]): FormService => {
    const real = shipped.get(name)
    if (real) return real
    const key = slug(name)
    return { key, name, tile, connection: { tile, auth: 'static_key', fields: [{ key: 'api_key', label: 'API key', input: 'secret', required: true, login: 'api_key' }] } }
  })
}

/** The design's mailboxes and drives, and `more` made up ones after them for a list at production length. */
function delegationOf(more: number): DelegationEntry[] {
  const fromFixture = fixture.delegation.map((d) => {
    const [by, day] = d.added.split(', ')
    const drive = d.kind === 'Shared drive'
    return {
      kind: drive ? 'drive' as const : 'mailbox' as const,
      subject: drive ? `0AFixture${slug(d.who).replace(/-/g, '')}` : d.who,
      display_name: drive ? d.who : null,
      added_by: by,
      added_at: etDayTimeToIso(day, '12:00 PM'),
    }
  })
  const extra = Array.from({ length: more }, (_, i): DelegationEntry => ({
    kind: i % 4 === 3 ? 'drive' : 'mailbox',
    subject: i % 4 === 3 ? `0AFixtureTeamDrive${i}` : `team${i + 1}@trypennie.com`,
    display_name: i % 4 === 3 ? `Team drive ${i + 1}` : null,
    added_by: i % 2 ? 'Dan Wright' : 'Ops team',
    added_at: etDayTimeToIso(`Oct ${1 + (i % 19)}`, '12:00 PM'),
  }))
  return [...fromFixture, ...extra]
}

function historyOf(c: FixtureConnection | undefined): HistoryEntry[] {
  return (c?.history ?? []).map(([day, clock, by, what], i) => ({
    id: `${slug(c!.name)}-${i}`,
    action: what === 'Added' ? 'INSERT' : 'UPDATE',
    at: etDayTimeToIso(day, clock),
    by: by === 'Bidspoke' ? null : by,
    credential_changed: /new client secret/.test(what),
    changes: {},
  }))
}

/** The Salesforce orgs the fixture knows, by host. */
export const PREVIEW_ORG_NAMES: Readonly<Record<string, string>> = Object.fromEntries(fixture.salesforceOrgs.map(([name, host]) => [host, name]))

/** The Slack alerts login's alert settings as GET /api/integrations/slack answers them, from the fixture (round 36). */
function alertsAnswer() {
  return { connected: true, workspace_name: 'Pennie', default_channel: fixture.alerts.channel, ...fixture.alerts.switches }
}

/** The settings as the page holds them once read. */
export const PREVIEW_ALERTS: AlertSettings = alertSettingsOf(alertsAnswer())!

export function previewSource(frame: string | undefined, moreGoogle = 0): ConnectionsSource {
  const shape = previewFrame(frame)
  const all: FixtureConnection[] = fixture.connections
  let subjects = delegationOf(moreGoogle)
  const answer: ConnectionList = {
    connections: all.map(rowOf),
    statuses: shape.list === 'stale'
      ? { stale: true, as_of: etTodayToIso(fixture.statusesAsOf), unavailable: { cause: 'deadline', detail: 'the preview draws the stale frame' } }
      : { stale: false, as_of: new Date(PREVIEW_NOW).toISOString(), unavailable: null },
  }
  const services = previewServices()
  return {
    create: (body) => {
      const host = typeof body.fields.instance_url === 'string' ? body.fields.instance_url.replace(/^https:\/\//, '') : null
      const actsAs = host === 'achieve.my.salesforce.com' ? fixture.justSaved.actsAs : host ? `integration@${host}` : null
      const created = { id: idOf(body.name), name: body.name, service: body.service, acts_as: actsAs, target: host ? { instance_url: `https://${host}`, client_id: body.fields.client_id ?? '' } : null, created_at: new Date(PREVIEW_NOW).toISOString() }
      if (!services.some((s) => s.key === body.service)) return Promise.reject(new Error('the preview offers no such service'))
      return Promise.resolve({ connection: created })
    },
    reconnect: (id) => Promise.resolve({ outcome: 'reconnected' as const, connection: { id, acts_as: null } }),
    remove: () => Promise.resolve({ outcome: 'removed' as const, ops: { told: true as const } }),
    list: () => {
      if (shape.list === 'loading') return new Promise(() => {})
      if (shape.list === 'failed') return Promise.reject(Object.assign(new Error('Timed out'), { timedOut: true, timeoutMs: 45_000 }))
      return Promise.resolve(answer)
    },
    history: (id) => Promise.resolve({ entries: historyOf(all.find((c) => idOf(c.name) === id)) }),
    googleSubjects: () => Promise.resolve({ subjects, reached_limit: false }),
    addGoogleSubject: (body) => {
      const entry: DelegationEntry = { kind: body.kind, subject: body.subject, display_name: body.display_name, added_by: 'Dan Wright', added_at: new Date(PREVIEW_NOW).toISOString() }
      subjects = [...subjects, entry]
      return Promise.resolve({ outcome: 'added', entry })
    },
    removeGoogleSubject: (kind, subject) => {
      subjects = subjects.filter((s) => !(s.kind === kind && s.subject === subject))
      return Promise.resolve({ outcome: 'removed' })
    },
    slackAlerts: () => Promise.resolve(alertsAnswer()),
    updateSlackAlerts: () => Promise.resolve({ ok: true }),
    searchSlackChannels: (q) => Promise.resolve({
      channels: fixture.alerts.channels.filter((c) => c.includes(q.toLowerCase())).map((c) => ({ id: slug(c), name: c.replace(/^#/, '') })),
    }),
    // The preview signs in to nothing: its link is Google's own page, which it never opens.
    startGoogleSignIn: () => Promise.resolve({ url: 'https://accounts.google.com/o/oauth2/v2/auth' }),
    goTo: () => undefined,
    finishGoogleSignIn: () => new Promise(() => {}),
    keptSignIns: keptSignInsIn(null),
  }
}

// ── The states the settled design never drew (rounds 29 to 31) ───────────────
//
// Each is reached by its URL alone, drawn through the real component and the
// reducer: the frame's events are applied before the first paint and nothing
// is fetched. A state that counts its seconds began ELAPSED_MS before
// PREVIEW_NOW, and the clock stands still there, so its picture is stable.

/** How long a counting state has been waiting in its picture. */
export const ELAPSED_MS = 4_000

/** The refusals the Worker's routes answer, worded as they word them (lib/connection-create-refusals.ts). */
const LIST_REFUSED = 'The connections could not be read: the use counts read failed.'
const SECRET_REFUSED = 'Salesforce refused the client secret. Nothing was saved. Check the secret and save again.'
/** The sign in route's sentence for a consent declined on Google's page (google_sign_in_denied, apps/worker/src/lib/google-sign-in.ts). */
export const GOOGLE_DECLINED = googleReturn.declined
const NO_CAP = 'Bidspoke has no limit set yet on how many Salesforce calls its workflows may make to lendco.my.salesforce.com, so it cannot connect to that org. Nothing was saved. Ask Dan to set a limit for this org, then save again.'
/** The create route's sentences for verify's two Slack refusals (apps/worker lib/connection-create-refusals.ts, #2337). */
const SLACK_NOT_A_BOT = 'This token acts as a person, not as a bot. Nothing was saved. Use the bot token from the ops Slack app and save again.'
const SLACK_OTHER_WORKSPACE = 'Slack says this bot is in another workspace than the Workspace ID entered. Nothing was saved. Check the Workspace ID and save again.'
/** The create route's sentence for verify's OpenAI project refusal (#2337). */
const OPENAI_OTHER_PROJECT = 'OpenAI says this API key belongs to another project than the Project ID entered. Nothing was saved. Check the Project ID and save again.'
/** The create route's sentence for verify's Anthropic workspace refusal (#2337). */
const ANTHROPIC_OTHER_WORKSPACE = 'Anthropic says this API key runs in another workspace than the Workspace ID entered. Nothing was saved. Check the Workspace ID and save again.'
/** The create route's sentence for verify's Google mailbox refusal (#2337). */
const GOOGLE_OTHER_MAILBOX = 'Google says this acts as another mailbox than the one chosen. Nothing was saved. Choose the mailbox again from the company list and save.'
const IN_USE = 'Daily Salesforce cleanup uses this connection, so it cannot be removed. Nothing was removed. Take it out of that workflow first.'
const OPS_NOT_TOLD = 'The connection is removed. The workflows server could not be told straight away, so it stops using the login at its next minute check, and within 6 hours at the latest if it cannot reach Bidspoke.'
const ADD_REFUSED = 'ops@trypennie is not one mailbox address or one shared drive id. Nothing was added. Check it and add it again.'
const REMOVE_REFUSED = 'Ops mailbox acts as ops@trypennie.com, so it cannot be taken off the list. Nothing was removed. Remove that connection first.'

export interface PreviewScript {
  events: ConnectionsEvent[]
  /** The org names the frame knows; empty draws an org by its address. */
  orgNames: Readonly<Record<string, string>>
  /** A control focused once drawn (an open menu), by selector. */
  focus?: string
  /** A list item chosen once drawn, by name (the leave question it asks). */
  leaveTo?: string
  /** What the alert channel's search box opens holding (the open channel menu). */
  channelQuery?: string
}

/** Every frame drawn this way, by id: the URL is /dev/connections?frame=<id>. */
export const SCRIPTED_FRAMES = [
  'loading', 'stale-retrying', 'stale-retry-failed', 'stale-no-earlier-time', 'not-loaded-refused',
  'google-adding', 'google-add-refused', 'google-removing', 'google-remove-refused', 'google-bad-address', 'google-add-drive',
  'notice-earlier-day', 'notice-many-workflows', 'notice-org-by-address', 'used-by-tab', 'history-tab', 'alert-login',
  // Build PR 10: the settled frames of the form and the dialogs, drawn by their events.
  'add-choose', 'add-salesforce', 'add-saving', 'add-failed', 'add-salesforce-new-org', 'add-google-company', 'add-google-own', 'saved', 'reconnect', 'replace', 'remove',
  // Build PR 10: the states of the form and the dialogs the settled design never drew.
  'add-stalled', 'add-failed-no-cap', 'add-snowflake', 'add-leave-ask', 'add-saving-leave-ask',
  'reconnect-saving', 'reconnect-failed', 'reconnect-stalled', 'reconnect-snowflake',
  'remove-removing', 'remove-refused-in-use', 'remove-ops-not-told',
  // Build PR 14: the Slack alerts login's alert settings and its Reconnect. alert-login and
  // alert-reconnect are settled frames; the rest are states the settled design never drew.
  'alert-reconnect', 'alert-reconnect-checking', 'alert-reconnect-refused', 'alert-login-refused',
  'alert-switch-saving', 'alert-switch-saved', 'alert-switch-failed',
  'alert-channel-open', 'alert-channel-chosen', 'alert-channel-saving', 'alert-channel-failed', 'alert-channel-saved',
  'alert-settings-loading', 'alert-settings-failed', 'alert-settings-none', 'alert-channel-leave-ask',
  // #2337: the ops Slack bot's form, its two verify refusals, and its panel.
  'add-slack', 'add-slack-not-a-bot', 'add-slack-workspace-mismatch', 'slack-ops-bot',
  // #2337: an OpenAI project's key: its form, verify's project refusal, and its panel.
  'add-openai', 'add-openai-project-mismatch', 'openai-summaries',
  // #2337: an Anthropic workspace's key: its form, verify's workspace refusal, and its panel.
  'add-anthropic', 'add-anthropic-workspace-mismatch', 'anthropic-lead-notes',
  // #2337: Google, the catalogue's own entry now: verify's mailbox refusal, and a company mailbox's panel.
  'add-google-mailbox-mismatch', 'google-ops-mailbox',
  // #2338 build PR 13, the settled return from Sign in with Google (docs/design/google-sign-in-return.html):
  // back in the add form, the finish running, and the sign in declined on Google's page.
  'add-google-own-finishing', 'add-google-own-declined',
] as const

export function previewScript(frame: string | undefined, moreGoogle = 0): PreviewScript | null {
  if (!frame || !(SCRIPTED_FRAMES as readonly string[]).includes(frame)) return null
  const T = PREVIEW_NOW
  const S = T - ELAPSED_MS
  const rows = fixture.connections.map((c) => rowOf(c as FixtureConnection))
  const listed = (over: (r: ConnectionListRow) => ConnectionListRow = (r) => r, statuses: ConnectionList['statuses'] = { stale: false, as_of: new Date(T).toISOString(), unavailable: null }): ConnectionsEvent =>
    ({ type: 'list_answered', attempt: 1, data: loadedOf({ connections: rows.map(over), statuses }) })
  const stale = (asOf: string | null): ConnectionList['statuses'] => ({ stale: true, as_of: asOf, unavailable: { cause: 'deadline', detail: 'the preview' } })
  const choose = (name: string): ConnectionsEvent => ({ type: 'choose', chosen: { kind: 'connection', id: idOf(name) } })
  // ?google=<n> lengthens the list in a scripted frame too, as it does a settled one (#2572).
  const google: ConnectionsEvent[] = [listed(), { type: 'google_answered', subjects: delegationOf(moreGoogle), reachedLimit: false }, { type: 'choose', chosen: { kind: 'google' } }]
  const ops = delegationOf(0)[0]
  const achieve = (over: Partial<ConnectionListRow>) => (r: ConnectionListRow) => (r.name === 'Achieve Salesforce' ? { ...r, ...over } : r)
  const achieveRow = rows.find((r) => r.name === 'Achieve Salesforce')!
  const known = PREVIEW_ORG_NAMES
  const script = (events: ConnectionsEvent[], orgNames: Readonly<Record<string, string>> = known): PreviewScript => ({ events, orgNames })
  switch (frame) {
    case 'loading':
      return script([{ type: 'list_requested', at: S, attempt: 2 }, { type: 'tick', at: T }])
    case 'stale-retrying':
      return script([listed(undefined, stale(etTodayToIso(fixture.statusesAsOf))), choose('Pennie Salesforce'), { type: 'list_requested', at: S, attempt: 2 }, { type: 'tick', at: T }])
    case 'stale-retry-failed':
      return script([listed(undefined, stale(etTodayToIso(fixture.statusesAsOf))), choose('Pennie Salesforce'), { type: 'list_requested', at: S, attempt: 2 }, { type: 'list_refused', attempt: 2, cause: LIST_NO_ANSWER }])
    case 'stale-no-earlier-time':
      return script([listed(undefined, stale(null)), choose('Pennie Salesforce')])
    case 'not-loaded-refused':
      return script([{ type: 'list_refused', attempt: 1, cause: LIST_REFUSED }])
    case 'google-adding':
      return script([...google, { type: 'draft', field: 'mailbox', text: 'partners@trypennie.com' }, { type: 'add_requested', at: S }, { type: 'tick', at: T }])
    case 'google-add-refused':
      return script([...google, { type: 'draft', field: 'mailbox', text: 'ops@trypennie' }, { type: 'add_requested', at: S }, { type: 'add_refused', sentence: ADD_REFUSED }])
    case 'google-removing':
      return script([...google, { type: 'remove_requested', entry: { kind: ops.kind, subject: ops.subject }, shown: ops.subject, at: S }, { type: 'tick', at: T }])
    case 'google-remove-refused':
      return script([...google, { type: 'remove_requested', entry: { kind: ops.kind, subject: ops.subject }, shown: ops.subject, at: S }, { type: 'remove_refused', sentence: REMOVE_REFUSED }])
    case 'google-bad-address':
      return script([...google, { type: 'draft_kind', kind: 'drive' },
        { type: 'draft', field: 'driveAddress', text: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrS/view?usp=sharing' },
        { type: 'draft', field: 'driveName', text: 'Partner invoices' }, { type: 'add_requested', at: T }])
    case 'google-add-drive':
      return script([...google, { type: 'draft_kind', kind: 'drive' },
        { type: 'draft', field: 'driveAddress', text: 'https://drive.google.com/drive/u/0/folders/0AbCdEfGhIjKlMnOpQrS?usp=sharing' },
        { type: 'draft', field: 'driveName', text: 'Partner invoices' }])
    case 'notice-earlier-day':
      return script([listed(achieve({ health: { ...achieveRow.health!, needs_reauth_at: '2026-10-18T13:52:00Z' } })), choose('Achieve Salesforce')])
    case 'notice-many-workflows': {
      const names = ['Achieve report import', 'Achieve payouts sync', 'Daily Salesforce cleanup', 'Lead Completed sync', 'Partner report email', 'Tripoint submission']
      return script([listed(achieve({ used_by: names.length, workflows: names.map((name) => ({ id: idOf(name), name, deleted: false })) })), choose('Achieve Salesforce')])
    }
    case 'notice-org-by-address':
      return script([listed(), choose('Achieve Salesforce')], {})
    case 'used-by-tab':
      return script([listed(), choose('Pennie Salesforce'), { type: 'tab', tab: 'used_by' }])
    case 'history-tab': {
      const pennie = fixture.connections.find((c) => c.name === 'Pennie Salesforce') as FixtureConnection
      return script([listed(), choose('Pennie Salesforce'), { type: 'tab', tab: 'history' }, { type: 'history_answered', id: idOf(pennie.name), entries: historyOf(pennie) }])
    }
    case 'alert-login':
      return script([listed(), choose('Bidspoke Alerts'), ALERTS_READ])
  }
  return alertScript(frame) ?? formScript(frame, moreGoogle)
}

/** The alert settings read, as every alert frame starts. */
const ALERTS_READ: ConnectionsEvent = { type: 'alerts_answered', settings: PREVIEW_ALERTS }

/** Slack's refusal of a new token, worded as the Worker words it (lib/connection-create-refusals.ts). */
const SLACK_REFUSED = 'Slack did not accept this token (invalid_auth). Nothing was saved. Check the token in the Slack app and save again.'

/** The Slack alerts login's frames (build PR 14), each drawn by the events a person's presses would send. */
function alertScript(frame: string): PreviewScript | null {
  const T = PREVIEW_NOW
  const S = T - ELAPSED_MS
  const rows = fixture.connections.map((c) => rowOf(c as FixtureConnection))
  const statuses: ConnectionList['statuses'] = { stale: false, as_of: new Date(T).toISOString(), unavailable: null }
  const listed = (over: (r: ConnectionListRow) => ConnectionListRow = (r) => r): ConnectionsEvent => ({ type: 'list_answered', attempt: 1, data: loadedOf({ connections: rows.map(over), statuses }) })
  const alertId = idOf('Bidspoke Alerts')
  const opened: ConnectionsEvent[] = [listed(), { type: 'choose', chosen: { kind: 'connection', id: alertId } }, ALERTS_READ]
  const reconnect: ConnectionsEvent[] = [...opened, { type: 'dialog_opened', dialog: 'reconnect', id: alertId }]
  const typedToken: ConnectionsEvent = { type: 'dialog_field', field: 'bot_token', text: 'plainsecrets' }
  const volumeOff = (at: number): ConnectionsEvent => ({ type: 'alerts_switch_requested', key: 'volume_alerts_enabled', to: false, attempt: 1, at })
  const channelOpen: ConnectionsEvent[] = [...opened, { type: 'alerts_channel_opened' }]
  const chosen: ConnectionsEvent[] = [...channelOpen, { type: 'alerts_channel_chosen', channel: '#ops-alerts' }]
  const saveChannel = (at: number): ConnectionsEvent => ({ type: 'alerts_channel_save_requested', attempt: 1, at })
  const script = (events: ConnectionsEvent[], more: Partial<PreviewScript> = {}): PreviewScript => ({ events, orgNames: PREVIEW_ORG_NAMES, ...more })
  const serverError = Object.assign(new Error('x'), { status: 503 })
  switch (frame) {
    case 'alert-reconnect':
      return script(reconnect)
    case 'alert-reconnect-checking':
      return script([...reconnect, typedToken, { type: 'reconnect_requested', attempt: 1, at: S, stalled: stalledSentence('Slack', CHANGE_DEADLINES.saveDeadlineMs, 'reconnected') }, { type: 'tick', at: T }])
    case 'alert-reconnect-refused':
      return script([...reconnect, typedToken, { type: 'reconnect_requested', attempt: 1, at: S, stalled: '' }, { type: 'reconnect_refused', attempt: 1, sentence: SLACK_REFUSED }])
    case 'alert-login-refused':
      // Slack refused the stored token: the notice, with Reconnect in it, as every login's.
      return script([listed((r) => (r.id === alertId ? { ...r, status: 'reauth', status_word: 'Needs reconnecting', checked_at: new Date(S).toISOString() } : r)), { type: 'choose', chosen: { kind: 'connection', id: alertId } }, ALERTS_READ])
    case 'alert-switch-saving':
      return script([...opened, volumeOff(S), { type: 'tick', at: T }])
    case 'alert-switch-saved':
      return script([...opened, volumeOff(S), { type: 'alerts_switch_answered', key: 'volume_alerts_enabled', attempt: 1 }])
    case 'alert-switch-failed':
      return script([...opened, volumeOff(S), { type: 'alerts_switch_refused', key: 'volume_alerts_enabled', attempt: 1, sentence: switchFailed('volume_alerts_enabled', false, serverError) }])
    case 'alert-channel-open':
      return script(channelOpen, { focus: '[data-part="channel-editor"] input', channelQuery: 'ops' })
    case 'alert-channel-chosen':
      return script(chosen)
    case 'alert-channel-saving':
      return script([...chosen, saveChannel(S), { type: 'tick', at: T }])
    case 'alert-channel-failed':
      return script([...chosen, saveChannel(S), { type: 'alerts_channel_save_refused', attempt: 1, sentence: channelFailed('#ops-alerts', serverError) }])
    case 'alert-channel-saved':
      return script([...chosen, saveChannel(S), { type: 'alerts_channel_save_answered', attempt: 1, channel: '#ops-alerts' }])
    case 'alert-settings-loading':
      return script([listed(), { type: 'choose', chosen: { kind: 'connection', id: alertId } }, { type: 'alerts_requested', at: S }, { type: 'tick', at: T }])
    case 'alert-settings-failed':
      return script([listed(), { type: 'choose', chosen: { kind: 'connection', id: alertId } }, { type: 'alerts_refused', sentence: 'The alert settings could not be read: the server did not answer within 30 seconds.' }])
    case 'alert-settings-none':
      return script([listed(), { type: 'choose', chosen: { kind: 'connection', id: alertId } }, { type: 'alerts_answered', settings: null }])
    case 'alert-channel-leave-ask':
      return script(chosen, { leaveTo: 'Ops alerts bot' })
  }
  return null
}

/** The form's and the dialogs' frames (build PR 10), each drawn by the events a person's presses would send. */
function formScript(frame: string, moreGoogle: number): PreviewScript | null {
  const T = PREVIEW_NOW
  const known = PREVIEW_ORG_NAMES
  const rows = fixture.connections.map((c) => rowOf(c as FixtureConnection))
  const justSaved = rowOf(fixture.justSaved as FixtureConnection)
  const statuses: ConnectionList['statuses'] = { stale: false, as_of: new Date(T).toISOString(), unavailable: null }
  const listed = (extra: ConnectionListRow[] = []): ConnectionsEvent => ({ type: 'list_answered', attempt: 1, data: loadedOf({ connections: [...rows, ...extra], statuses }) })
  // ?google=<n>: the add form's mailboxes and drives at production length (#2572).
  const google: ConnectionsEvent = { type: 'google_answered', subjects: delegationOf(moreGoogle), reachedLimit: false }
  const choose = (name: string): ConnectionsEvent => ({ type: 'choose', chosen: { kind: 'connection', id: idOf(name) } })
  const sf = fixture.draft.salesforce
  const elapsed = Number.parseInt(sf.elapsed, 10) * 1000
  const deadline = CHANGE_DEADLINES.saveDeadlineMs
  const stalled = stalledSentence('Salesforce', deadline, 'saved')
  const opened: ConnectionsEvent[] = [listed(), google, choose('Pennie Salesforce'), { type: 'add_opened' }]
  const salesforce = (name = sf.name, org = 'https://achieve.my.salesforce.com', typedNew = false): ConnectionsEvent[] => [
    ...opened,
    { type: 'add_service', service: 'salesforce' },
    { type: 'add_name', text: name },
    { type: 'add_field', field: 'instance_url', text: org, typedNew },
    { type: 'add_field', field: 'client_id', text: sf.clientId },
    // A plain word, twelve letters, so the masked box shows the design's twelve dots.
    { type: 'add_field', field: 'client_secret', text: 'plainsecrets' },
  ]
  const saveAt = (at: number): ConnectionsEvent => ({ type: 'save_requested', attempt: 1, at, stalled })
  // A plain word in the token box, so the masked box shows dots and no token shape.
  const slackForm: ConnectionsEvent[] = [
    ...opened,
    { type: 'add_service', service: 'slack' },
    { type: 'add_name', text: 'Ops reports bot' },
    { type: 'add_field', field: 'team_id', text: 'T0PENNIE' },
    { type: 'add_field', field: 'bot_token', text: 'plainbottoken' },
  ]
  const openaiForm: ConnectionsEvent[] = [
    ...opened,
    { type: 'add_service', service: 'openai' },
    { type: 'add_name', text: 'Lead summaries' },
    { type: 'add_field', field: 'project_id', text: 'proj_bidspoke_ops' },
    { type: 'add_field', field: 'api_key', text: 'plainapikey' },
  ]
  const anthropicForm: ConnectionsEvent[] = [
    ...opened,
    { type: 'add_service', service: 'anthropic' },
    { type: 'add_name', text: 'Loan document review' },
    { type: 'add_field', field: 'workspace_id', text: 'wrkspc_ops' },
    { type: 'add_field', field: 'api_key', text: 'plainapikey' },
  ]
  const googleForm: ConnectionsEvent[] = [
    ...opened, { type: 'add_service', service: 'google' }, { type: 'add_name', text: fixture.draft.google.companyName }, { type: 'add_field', field: 'subject', text: fixture.draft.google.subject },
  ]
  const ownForm: ConnectionsEvent[] = [...opened, { type: 'add_service', service: 'google' }, { type: 'add_google', way: 'own' }, { type: 'add_name', text: fixture.draft.google.ownName }]
  // Back from Google (D1): the finish running in the add form, its working line under the buttons.
  const finishing = (at: number): ConnectionsEvent => ({ type: 'save_requested', attempt: 1, at, stalled: stalledSentence('Google', deadline, 'saved'), label: FINISHING_LABEL })
  const reconnectOf = (name: string): ConnectionsEvent[] => [listed(), google, choose(name), { type: 'dialog_opened', dialog: 'reconnect', id: idOf(name) }]
  const removeOf = (): ConnectionsEvent[] => [listed([justSaved]), google, choose(fixture.justSaved.name), { type: 'dialog_opened', dialog: 'remove', id: idOf(fixture.justSaved.name) }]
  const typedSecret: ConnectionsEvent = { type: 'dialog_field', field: 'client_secret', text: 'plainsecrets' }
  const script = (events: ConnectionsEvent[], more: Partial<PreviewScript> = {}): PreviewScript => ({ events, orgNames: known, ...more })
  const S = T - ELAPSED_MS
  switch (frame) {
    case 'add-choose':
      return script(opened)
    case 'add-salesforce':
      return script(salesforce())
    case 'add-saving':
      return script([...salesforce(), saveAt(T - elapsed), { type: 'tick', at: T }])
    case 'add-failed':
      return script([...salesforce(), saveAt(T - elapsed), { type: 'save_refused', attempt: 1, sentence: SECRET_REFUSED }])
    case 'add-salesforce-new-org':
      return script(salesforce(fixture.draft.newOrg.name, fixture.draft.newOrg.address, true), { focus: '[data-part="add-form"] [data-field="Org"] input' })
    case 'add-google-company':
      return script(googleForm)
    case 'add-google-mailbox-mismatch':
      return script([...googleForm, saveAt(T - elapsed), { type: 'save_refused', attempt: 1, sentence: GOOGLE_OTHER_MAILBOX }])
    case 'google-ops-mailbox':
      return script([listed(), google, choose('Ops mailbox')])
    case 'add-google-own':
      return script(ownForm)
    case 'add-google-own-finishing':
      return script([...ownForm, finishing(T - Number.parseInt(googleReturn.elapsed, 10) * 1000), { type: 'tick', at: T }])
    case 'add-google-own-declined':
      return script([...ownForm, finishing(T - elapsed), { type: 'save_refused', attempt: 1, sentence: GOOGLE_DECLINED }])
    case 'saved': {
      const service = catalogueServices().find((x) => x.key === 'salesforce')!
      const answer = { id: idOf(fixture.justSaved.name), name: fixture.justSaved.name, service: 'salesforce', acts_as: fixture.justSaved.actsAs, target: { instance_url: `https://${fixture.justSaved.instance}`, client_id: sf.clientId }, created_at: new Date(T).toISOString() }
      return script([...salesforce(), saveAt(T - elapsed), { type: 'save_answered', attempt: 1, connection: createdView(answer, service, T) }])
    }
    case 'reconnect':
      return script(reconnectOf('Achieve Salesforce'))
    case 'replace':
      return script([listed(), google, choose('Pennie Salesforce'), { type: 'dialog_opened', dialog: 'replace', id: idOf('Pennie Salesforce') }])
    case 'remove':
      return script(removeOf())
    case 'add-stalled':
      return script([...salesforce(), saveAt(T - deadline), { type: 'tick', at: T }])
    case 'add-failed-no-cap':
      return script([...salesforce(fixture.draft.newOrg.name, fixture.draft.newOrg.address, true), saveAt(T - elapsed), { type: 'save_refused', attempt: 1, sentence: NO_CAP }])
    case 'add-snowflake':
      return script([...opened, { type: 'add_service', service: 'snowflake' }, { type: 'add_name', text: 'Reporting warehouse 2' }, { type: 'add_field', field: 'account', text: 'PENNIE' }, { type: 'add_field', field: 'user', text: 'OPS_SERVICE' }, { type: 'add_field', field: 'private_key', text: 'preview key line one\npreview key line two\npreview key line three' }])
    case 'add-leave-ask':
      return script(salesforce(), { leaveTo: 'TPL2 Salesforce' })
    case 'add-saving-leave-ask':
      return script([...salesforce(), saveAt(S), { type: 'tick', at: T }], { leaveTo: 'TPL2 Salesforce' })
    case 'reconnect-saving':
      return script([...reconnectOf('Achieve Salesforce'), typedSecret, { type: 'reconnect_requested', attempt: 1, at: S, stalled: stalledSentence('Salesforce', deadline, 'reconnected') }, { type: 'tick', at: T }])
    case 'reconnect-failed':
      return script([...reconnectOf('Achieve Salesforce'), typedSecret, { type: 'reconnect_requested', attempt: 1, at: S, stalled: '' }, { type: 'reconnect_refused', attempt: 1, sentence: SECRET_REFUSED }])
    case 'reconnect-stalled':
      return script([...reconnectOf('Achieve Salesforce'), typedSecret, { type: 'reconnect_requested', attempt: 1, at: T - deadline, stalled: stalledSentence('Salesforce', deadline, 'reconnected') }, { type: 'tick', at: T }])
    case 'reconnect-snowflake':
      return script(reconnectOf('Reporting warehouse'))
    case 'remove-removing':
      return script([...removeOf(), { type: 'connection_remove_requested', attempt: 1, at: S, stalled: stalledSentence('Salesforce', CHANGE_DEADLINES.removeDeadlineMs, 'removed') }, { type: 'tick', at: T }])
    case 'remove-refused-in-use':
      return script([...removeOf(), { type: 'connection_remove_requested', attempt: 1, at: S, stalled: '' }, { type: 'connection_remove_refused', attempt: 1, sentence: IN_USE, workflows: [{ id: idOf('Daily Salesforce cleanup'), name: 'Daily Salesforce cleanup', deleted: false }] }])
    case 'add-slack':
      return script(slackForm)
    case 'add-slack-not-a-bot':
      return script([...slackForm, saveAt(T - elapsed), { type: 'save_refused', attempt: 1, sentence: SLACK_NOT_A_BOT }])
    case 'add-slack-workspace-mismatch':
      return script([...slackForm, saveAt(T - elapsed), { type: 'save_refused', attempt: 1, sentence: SLACK_OTHER_WORKSPACE }])
    case 'slack-ops-bot':
      return script([listed(), google, choose('Ops alerts bot')])
    case 'add-openai':
      return script(openaiForm)
    case 'add-openai-project-mismatch':
      return script([...openaiForm, saveAt(T - elapsed), { type: 'save_refused', attempt: 1, sentence: OPENAI_OTHER_PROJECT }])
    case 'openai-summaries':
      return script([listed(), google, choose('Summaries')])
    case 'add-anthropic':
      return script(anthropicForm)
    case 'add-anthropic-workspace-mismatch':
      return script([...anthropicForm, saveAt(T - elapsed), { type: 'save_refused', attempt: 1, sentence: ANTHROPIC_OTHER_WORKSPACE }])
    case 'anthropic-lead-notes':
      return script([listed(), google, choose('Lead notes')])
    case 'remove-ops-not-told':
      return script([...removeOf(), { type: 'connection_remove_requested', attempt: 1, at: S, stalled: '' }, { type: 'connection_remove_answered', attempt: 1, id: idOf(fixture.justSaved.name), notice: OPS_NOT_TOLD }])
  }
  return null
}
