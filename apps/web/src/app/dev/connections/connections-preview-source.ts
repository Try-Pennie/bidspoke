/**
 * The development preview's data for the Connections page (#2338, build PR 9):
 * the settled design's own fixture (docs/design/connections-page.fixture.json),
 * turned into what the Worker's routes answer, so the page draws exactly what
 * the design's frames draw and the design score can compare the two. No
 * network: every call is answered here. Not served in a production build.
 */
import type { ConnectionList, ConnectionListRow } from '@/lib/api'
import fixture from '../../../../../../docs/design/connections-page.fixture.json'
import { loadedOf, type ConnectionsSource } from '@/components/connections/ConnectionsScreen'
import { LIST_NO_ANSWER, type Chosen, type ConnectionsEvent } from '@/components/connections/connections-state'
import type { DelegationEntry, HistoryEntry } from '@/components/connections/connection-model'

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
    acts_as: c.actsAs,
    person_bound: c.kind === 'person',
    owner: null,
    target: c.instance ? { instance_url: `https://${c.instance}` } : null,
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

/** The frames this build draws, and what each chooses. The add, dialog and saved frames are build PR 10's. */
export function previewFrame(frame: string | undefined): { list: 'loaded' | 'stale' | 'failed' | 'loading'; extra: boolean; chosen: Chosen } {
  const chosen = (name: string): Chosen => ({ kind: 'connection', id: idOf(name) })
  switch (frame) {
    case 'problem':
    case 'reconnect':
      return { list: 'loaded', extra: false, chosen: chosen('Achieve Salesforce') }
    case 'google-list':
      return { list: 'loaded', extra: false, chosen: { kind: 'google' } }
    case 'stale':
      return { list: 'stale', extra: false, chosen: chosen('Pennie Salesforce') }
    case 'not-loaded':
      return { list: 'failed', extra: false, chosen: { kind: 'none' } }
    case 'saved':
    case 'remove':
      return { list: 'loaded', extra: true, chosen: chosen(fixture.justSaved.name) }
    default:
      return { list: 'loaded', extra: false, chosen: chosen('Pennie Salesforce') }
  }
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

export function previewSource(frame: string | undefined, moreGoogle = 0): ConnectionsSource {
  const shape = previewFrame(frame)
  const all: FixtureConnection[] = [...fixture.connections, ...(shape.extra ? [fixture.justSaved] : [])]
  let subjects = delegationOf(moreGoogle)
  const answer: ConnectionList = {
    connections: all.map(rowOf),
    statuses: shape.list === 'stale'
      ? { stale: true, as_of: etTodayToIso(fixture.statusesAsOf), unavailable: { cause: 'deadline', detail: 'the preview draws the stale frame' } }
      : { stale: false, as_of: new Date(PREVIEW_NOW).toISOString(), unavailable: null },
  }
  return {
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
const ADD_REFUSED = 'ops@trypennie is not one mailbox address or one shared drive id. Nothing was added. Check it and add it again.'
const REMOVE_REFUSED = 'Ops mailbox acts as ops@trypennie.com, so it cannot be taken off the list. Nothing was removed. Remove that connection first.'

export interface PreviewScript {
  events: ConnectionsEvent[]
  /** The org names the frame knows; empty draws an org by its address. */
  orgNames: Readonly<Record<string, string>>
}

/** Every frame drawn this way, by id: the URL is /dev/connections?frame=<id>. */
export const SCRIPTED_FRAMES = [
  'loading', 'stale-retrying', 'stale-retry-failed', 'stale-no-earlier-time', 'not-loaded-refused',
  'google-adding', 'google-add-refused', 'google-removing', 'google-remove-refused', 'google-bad-address', 'google-add-drive',
  'notice-earlier-day', 'notice-many-workflows', 'notice-org-by-address', 'used-by-tab', 'history-tab', 'alert-login',
] as const

export function previewScript(frame: string | undefined): PreviewScript | null {
  if (!frame || !(SCRIPTED_FRAMES as readonly string[]).includes(frame)) return null
  const T = PREVIEW_NOW
  const S = T - ELAPSED_MS
  const rows = fixture.connections.map((c) => rowOf(c as FixtureConnection))
  const listed = (over: (r: ConnectionListRow) => ConnectionListRow = (r) => r, statuses: ConnectionList['statuses'] = { stale: false, as_of: new Date(T).toISOString(), unavailable: null }): ConnectionsEvent =>
    ({ type: 'list_answered', attempt: 1, data: loadedOf({ connections: rows.map(over), statuses }) })
  const stale = (asOf: string | null): ConnectionList['statuses'] => ({ stale: true, as_of: asOf, unavailable: { cause: 'deadline', detail: 'the preview' } })
  const choose = (name: string): ConnectionsEvent => ({ type: 'choose', chosen: { kind: 'connection', id: idOf(name) } })
  const google: ConnectionsEvent[] = [listed(), { type: 'google_answered', subjects: delegationOf(0), reachedLimit: false }, { type: 'choose', chosen: { kind: 'google' } }]
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
      return script([listed(), choose('Bidspoke Alerts')])
  }
  return null
}
