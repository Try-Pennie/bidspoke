/**
 * The spike's ledger (#2131, L515): a file naming everything the spike creates in
 * production, written BEFORE each thing is created and again once its id is
 * known, so `--cleanup <ledger>` can remove it after any interrupt, crash or
 * kill, including one that lands between a create and the id being recorded.
 *
 * Every key carries the run's marker, `realtime-spike-<UTC timestamp>`, and both
 * the ledger and the cleanup refuse a key that does not, so a ledger edited by
 * hand or written by something else can never steer the cleanup at a real row.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export type EntryKind = 'allowlist' | 'organization' | 'auth_user' | 'public_user'
export type EntryState = 'planned' | 'created'

export interface LedgerEntry {
  kind: EntryKind
  /** The email (allowlist, users) or the slug (organization), always carrying the marker. */
  key: string
  id: string | null
  state: EntryState
}

export interface Ledger {
  version: 1
  marker: string
  project: string
  startedAt: string
  entries: LedgerEntry[]
}

/** Synchronous on purpose: a signal handler must be able to read it with nothing pending. */
export interface LedgerIo {
  exists(path: string): boolean
  read(path: string): string
  write(path: string, text: string): void
}

export interface LedgerHandle {
  readonly path: string
  plan(kind: EntryKind, key: string, id: string | null): void
  created(kind: EntryKind, key: string, id: string | null): void
  current(): Ledger
}

const MARKER_PATTERN = /^realtime-spike-\d{8}t\d{6}z$/

export function makeMarker(at: Date): string {
  const iso = at.toISOString() // 2026-10-15T15:30:12.345Z
  const compact = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}t${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}z`
  return `realtime-spike-${compact}`
}

export function isSpikeMarker(marker: string): boolean {
  return MARKER_PATTERN.test(marker)
}

/**
 * Org B's one user. The marker is in the DOMAIN because handle_new_auth_user
 * files a new auth user under the organization whose slug is derived from the
 * email's domain; example.com is reserved (RFC 2606), so no mail can be sent.
 */
export function emailForMarker(marker: string): string {
  return `org-b@${marker}.example.com`
}

/** The slug handle_new_auth_user derives: lower(regexp_replace(domain, '[^a-z0-9]', '-', 'g')). */
export function orgSlugForEmail(email: string): string {
  const domain = email.split('@')[1] ?? ''
  return domain.replace(/[^a-z0-9]/g, '-').toLowerCase()
}

export function newLedger(marker: string, project: string, startedAt: string): Ledger {
  if (!isSpikeMarker(marker)) throw new Error(`'${marker}' is not a realtime spike marker`)
  return { version: 1, marker, project, startedAt, entries: [] }
}

export function keyCarriesMarker(key: string, marker: string): boolean {
  return isSpikeMarker(marker) && key.includes(marker)
}

export function openLedger(path: string, initial: Ledger, io: LedgerIo): LedgerHandle {
  if (io.exists(path)) {
    throw new Error(`${path} already exists; it may name rows an earlier run left behind. Clean it up with --cleanup ${path}, or pick a new path.`)
  }
  const ledger: Ledger = { ...initial, entries: [...initial.entries] }
  const save = () => io.write(path, `${JSON.stringify(ledger, null, 2)}\n`)
  save()
  return {
    path,
    plan(kind, key, id) {
      if (!keyCarriesMarker(key, ledger.marker)) {
        throw new Error(`refusing to plan ${kind} '${key}': it does not carry the marker ${ledger.marker}`)
      }
      ledger.entries.push({ kind, key, id, state: 'planned' })
      save()
    },
    created(kind, key, id) {
      const entry = ledger.entries.find((e) => e.kind === kind && e.key === key)
      if (!entry) throw new Error(`no planned ${kind} '${key}' in the ledger`)
      entry.id = id ?? entry.id
      entry.state = 'created'
      save()
    },
    current: () => ledger,
  }
}

const KINDS: ReadonlySet<string> = new Set(['allowlist', 'organization', 'auth_user', 'public_user'])

export function readLedger(path: string, io: LedgerIo): Ledger {
  let parsed: unknown
  try {
    parsed = JSON.parse(io.read(path))
  } catch (err) {
    throw new Error(`${path} is not a realtime spike ledger: ${err instanceof Error ? err.message : 'unreadable'}`, { cause: err })
  }
  const l = parsed as Partial<Ledger>
  const ok =
    l !== null &&
    typeof l === 'object' &&
    l.version === 1 &&
    typeof l.marker === 'string' &&
    isSpikeMarker(l.marker) &&
    Array.isArray(l.entries) &&
    l.entries.every((e) => KINDS.has(e.kind) && typeof e.key === 'string' && (e.state === 'planned' || e.state === 'created'))
  if (!ok) throw new Error(`${path} is not a realtime spike ledger (no valid marker, version or entries)`)
  return l as Ledger
}

/** The real file system, writing through a temporary file and a rename so an interrupt never leaves half a ledger. */
export const nodeLedgerIo: LedgerIo = {
  exists: (path) => existsSync(path),
  read: (path) => readFileSync(path, 'utf8'),
  write: (path, text) => {
    const tmp = `${path}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, path)
  },
}
