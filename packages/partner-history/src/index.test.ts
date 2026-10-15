/**
 * The pure half of the partners page History (#2141): how a row names its
 * editor, and how two bounded sources merge without a gap.
 */
import { describe, it, expect } from 'vitest'
import {
  auditEditor,
  matrixEditor,
  editorLabel,
  mergeHistory,
  readNewest,
  HISTORY_ROWS_PER_SOURCE,
  UnresolvedEditorError,
  type HistoryEntry,
} from './index'

const users = new Map([
  ['u-1', { id: 'u-1', display_name: 'Dan Wright', email: 'dan@pennie.com' }],
  ['u-2', { id: 'u-2', display_name: '  ', email: 'erin@example.test' }],
])

describe('auditEditor (#2141, L37)', () => {
  it('names the users row first, falling back to its address, over any stamped name', () => {
    expect(auditEditor({ changed_by: 'u-1', changes: { _actor: { name: 'Old Name' } } }, users)).toEqual({ kind: 'person', userId: 'u-1', name: 'Dan Wright', via: null })
    expect(auditEditor({ changed_by: 'u-2', changes: null }, users)).toEqual({ kind: 'person', userId: 'u-2', name: 'erin@example.test', via: null })
  })

  it('uses the stamped name only for a row with no changed_by', () => {
    expect(auditEditor({ changed_by: null, changes: { _actor: { name: 'Sam', email: 'sam@example.test' } } }, users)).toEqual({ kind: 'person', userId: null, name: 'Sam', via: null })
    expect(auditEditor({ changed_by: null, changes: { _actor: { name: null, email: 'sam@example.test' } } }, users)).toEqual({ kind: 'person', userId: null, name: 'sam@example.test', via: null })
  })

  it('credits a job by name, and a row with neither actor nor job is a direct edit, never a person', () => {
    expect(auditEditor({ changed_by: null, changes: { _source: 'job', _job: 'nightly' } }, users)).toEqual({ kind: 'job', job: 'nightly' })
    expect(auditEditor({ changed_by: null, changes: { _source: 'direct_sql' } }, users)).toEqual({ kind: 'direct' })
    expect(auditEditor({ changed_by: null, changes: null }, users)).toEqual({ kind: 'direct' })
    expect(auditEditor({ changed_by: null, changes: { _actor: { name: '', email: '' } } }, users)).toEqual({ kind: 'direct' })
  })

  it('throws, never labels, when changed_by has no users row', () => {
    expect(() => auditEditor({ changed_by: 'u-gone', changes: null }, users)).toThrow(UnresolvedEditorError)
  })
})

describe('matrixEditor (#2141)', () => {
  it('a press is the person, a row with no person is the hourly job', () => {
    expect(matrixEditor({ changed_by: 'u-1', source: 'salesforce_sync' }, users)).toEqual({ kind: 'person', userId: 'u-1', name: 'Dan Wright', via: 'sync_now' })
    expect(matrixEditor({ changed_by: null, source: 'salesforce_sync' }, users)).toEqual({ kind: 'job', job: 'salesforce_matrix_sync' })
    expect(matrixEditor({ changed_by: null, source: 'user_edit' }, users)).toEqual({ kind: 'direct' })
    expect(matrixEditor({ changed_by: 'u-1', source: 'user_edit' }, users)).toEqual({ kind: 'person', userId: 'u-1', name: 'Dan Wright', via: null })
  })
})

describe('editorLabel (#2141)', () => {
  it('says who, in words', () => {
    expect(editorLabel({ kind: 'person', userId: 'u-1', name: 'Dan Wright', via: 'sync_now' })).toBe('Dan Wright, Sync now from Salesforce')
    expect(editorLabel({ kind: 'person', userId: null, name: 'Sam', via: null })).toBe('Sam')
    expect(editorLabel({ kind: 'job', job: 'salesforce_matrix_sync' })).toBe('Bidspoke, hourly Salesforce matrix sync')
    expect(editorLabel({ kind: 'job', job: 'nightly' })).toBe('Bidspoke job nightly')
    expect(editorLabel({ kind: 'direct' })).toBe('Changed directly in the database')
  })
})

function entry(key: string, at: string): HistoryEntry {
  return { key, source: 'audit_log', at, entityType: 'partner_config', entityId: 'p', action: 'updated', editor: { kind: 'direct' }, editorLabel: 'x', changes: null, matrix: null }
}

describe('mergeHistory (#2141)', () => {
  it('orders newest first, ties by key, and is complete when no source was cut', () => {
    const merged = mergeHistory([
      { entries: [entry('audit:b', '2026-10-15T10:00:00+00:00'), entry('audit:a', '2026-10-15T10:00:00+00:00')], truncated: false },
      { entries: [entry('matrix:c', '2026-10-15T11:00:00Z')], truncated: false },
    ])
    expect(merged.entries.map((e) => e.key)).toEqual(['matrix:c', 'audit:a', 'audit:b'])
    expect(merged.complete).toBe(true)
    expect(merged.completeSince).toBeNull()
  })

  it('cuts at the oldest instant a truncated source still covers, so no other source shows rows from its gap', () => {
    const merged = mergeHistory([
      // Cut: this source holds older rows it did not return.
      { entries: [entry('audit:new', '2026-10-15T12:00:00Z'), entry('audit:edge', '2026-10-15T09:00:00Z')], truncated: true },
      { entries: [entry('matrix:in', '2026-10-15T10:00:00Z'), entry('matrix:tie', '2026-10-15T09:00:00Z'), entry('matrix:old', '2026-10-14T09:00:00Z')], truncated: false },
    ])
    expect(merged.entries.map((e) => e.key)).toEqual(['audit:new', 'matrix:in'])
    expect(merged.complete).toBe(false)
    expect(merged.completeSince).toBe('2026-10-15T09:00:00.000Z')
  })
})

describe('readNewest (#2141)', () => {
  it('pages until a short page, and reports truncation at the bound rather than stopping silently', async () => {
    const pages: Array<[number, number]> = []
    const full = Array.from({ length: 1000 }, (_, i) => ({ i }))
    const all = await readNewest(async (from, to) => {
      pages.push([from, to])
      return { data: from === 0 ? full : full.slice(0, 5), error: null }
    })
    expect(pages).toEqual([[0, 999], [1000, 1999]])
    expect(all.rows).toHaveLength(1005)
    expect(all.truncated).toBe(false)

    const bounded = await readNewest(async () => ({ data: full, error: null }))
    expect(bounded.rows).toHaveLength(HISTORY_ROWS_PER_SOURCE)
    expect(bounded.truncated).toBe(true)
  })

  it('throws on a read error, never returns what it had', async () => {
    await expect(readNewest(async (from) => (from === 0 ? { data: [{ i: 1 }], error: null } : { data: null, error: { message: 'x' } }))).resolves.toBeDefined()
    const full = Array.from({ length: 1000 }, (_, i) => ({ i }))
    await expect(readNewest(async (from) => (from === 0 ? { data: full, error: null } : { data: null, error: { message: 'timeout' } }))).rejects.toThrow('timeout')
  })
})
