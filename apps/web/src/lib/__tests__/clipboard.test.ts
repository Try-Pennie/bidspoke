/**
 * Cross-workflow copy/paste — PRD Section 3.4
 * Verifies that writeClipboard deep-clones node data (so mutations to the
 * original don't affect the clipboard and vice versa), that readClipboard
 * returns null for an empty / corrupt store, and that the localStorage key
 * is stable across workflow navigations.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { writeClipboard, readClipboard, pasteIdentity, CLIPBOARD_KEY } from '../clipboard'

// Minimal localStorage mock — vitest/node has no DOM APIs
const store: Record<string, string> = {}
const localStorageMock = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v },
  removeItem: (k: string) => { delete store[k] },
  clear: () => { for (const k of Object.keys(store)) delete store[k] },
}
vi.stubGlobal('localStorage', localStorageMock)

beforeEach(() => localStorageMock.clear())

describe('writeClipboard', () => {
  it('persists entry to localStorage under the expected key', () => {
    writeClipboard({ type: 'filter', config: { rules: [] }, variables: {}, position: { x: 100, y: 200 } })
    expect(localStorage.getItem(CLIPBOARD_KEY)).not.toBeNull()
  })

  it('deep-clones config — mutations to original do not affect clipboard', () => {
    const config: Record<string, unknown> = { nested: { value: 1 } }
    writeClipboard({ type: 'filter', config, variables: {}, position: { x: 0, y: 0 } })
    // Mutate the original after writing
    ;(config.nested as Record<string, unknown>).value = 999
    const stored = readClipboard()
    expect((stored!.config.nested as Record<string, unknown>).value).toBe(1)
  })

  it('deep-clones variables — mutations to original do not affect clipboard', () => {
    const variables: Record<string, unknown> = { key: 'original' }
    writeClipboard({ type: 'code', config: {}, variables, position: { x: 0, y: 0 } })
    variables.key = 'mutated'
    const stored = readClipboard()
    expect(stored!.variables.key).toBe('original')
  })

  it('overwrites any previous clipboard entry', () => {
    writeClipboard({ type: 'filter', config: { first: true }, variables: {}, position: { x: 0, y: 0 } })
    writeClipboard({ type: 'branch', config: { second: true }, variables: {}, position: { x: 10, y: 20 } })
    const stored = readClipboard()
    expect(stored!.type).toBe('branch')
    expect(stored!.config.second).toBe(true)
  })
})

describe('readClipboard', () => {
  it('returns null when localStorage is empty', () => {
    expect(readClipboard()).toBeNull()
  })

  it('returns null when localStorage value is invalid JSON', () => {
    localStorage.setItem(CLIPBOARD_KEY, 'not-json{{{')
    expect(readClipboard()).toBeNull()
  })

  it('round-trips: entry written is entry read back', () => {
    const entry = { type: 'transform' as const, config: { mappings: [{ from: 'a', to: 'b' }] }, variables: { X: 'hello' }, position: { x: 42, y: 84 } }
    writeClipboard(entry)
    const stored = readClipboard()
    expect(stored).toEqual(entry)
  })

  it('clipboard persists across separate read calls (simulating different workflows)', () => {
    writeClipboard({ type: 'exit', config: {}, variables: {}, position: { x: 5, y: 5 } })
    // Simulate navigating to another workflow — localStorage still has the entry
    const read1 = readClipboard()
    const read2 = readClipboard()
    expect(read1).toEqual(read2)
    expect(read1!.type).toBe('exit')
  })

  it('mutations to the returned object do not affect subsequent reads', () => {
    writeClipboard({ type: 'filter', config: { deep: { value: 42 } }, variables: {}, position: { x: 0, y: 0 } })
    const first = readClipboard()!
    ;(first.config.deep as Record<string, unknown>).value = 0
    const second = readClipboard()!
    expect((second.config.deep as Record<string, unknown>).value).toBe(42)
  })
})

// #2590: a lead validation swap pastes the proven node rather than retyping it,
// and lead sightings and Snowflake record the step by its namespace and label,
// so a paste keeps both whenever the namespace is free in the workflow.
describe('a pasted node keeps its namespace and label', () => {
  const proven = {
    type: 'lead_validation' as const,
    namespace: 'validate_bidding_and_state',
    label: 'Validate bidding and state',
    config: { lead_id_field: 'trigger.payload.leadUuid', checks: [] },
    variables: {},
    position: { x: 0, y: 0 },
  }

  it('carries them through the clipboard', () => {
    writeClipboard(proven)
    expect(readClipboard()).toMatchObject({ namespace: 'validate_bidding_and_state', label: 'Validate bidding and state' })
  })

  it('pastes under them when the namespace is free', () => {
    expect(pasteIdentity(proven, ['constants', 'parse_name'])).toEqual({ namespace: 'validate_bidding_and_state', label: 'Validate bidding and state' })
  })

  it('falls back to the type default, as before, when the namespace is taken, so a copy never shares one', () => {
    expect(pasteIdentity(proven, ['validate_bidding_and_state'])).toEqual({})
  })

  it('falls back to the type default for an entry copied before names were carried', () => {
    expect(pasteIdentity({ type: 'filter', config: {}, variables: {}, position: { x: 0, y: 0 } }, [])).toEqual({})
  })

  // WorkflowCanvas cannot be mounted in jsdom (#737), so its two halves are read
  // from source: the copy writes the names, and the paste key asks pasteIdentity.
  it('is wired into the canvas copy and paste keys', () => {
    const src = readFileSync(path.join(__dirname, '..', '..', 'components', 'canvas', 'WorkflowCanvas.tsx'), 'utf8')
    const copyAt = src.indexOf('function copyNode')
    const copy = src.slice(copyAt, src.indexOf('\n  }\n', copyAt))
    expect(copy).toMatch(/namespace: d\.namespace/)
    expect(copy).toMatch(/label: d\.label/)
    const pasteKey = src.slice(src.indexOf('// Cmd+V'), src.indexOf('// Cmd+D'))
    expect(pasteKey).toMatch(/pasteIdentity\(cb, nodeNamespaces\)/)
  })
})
