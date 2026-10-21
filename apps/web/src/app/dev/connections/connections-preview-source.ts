/**
 * The development preview's data for the Connections page (#2338, build PR 9):
 * the settled design's own fixture (docs/design/connections-page.fixture.json),
 * turned into what the Worker's routes answer, so the page draws exactly what
 * the design's frames draw and the design score can compare the two. No
 * network: every call is answered here. Not served in a production build.
 */
import type { ConnectionList, ConnectionListRow } from '@/lib/api'
import fixture from '../../../../../../docs/design/connections-page.fixture.json'
import type { ConnectionsSource } from '@/components/connections/ConnectionsScreen'
import type { Chosen } from '@/components/connections/connections-state'
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
    case 'loading':
      return { list: 'loading', extra: false, chosen: { kind: 'none' } }
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
