/**
 * The last good copy of each ops version's plain variables (#2999, phase 3 of
 * #2982): what a copy entry holds, and when a claimed run may use it.
 *
 * The database half is proven in supabase-ops/supabase/tests/variable_copies.test.sql,
 * and the tick's use of both (the single write, the refresh, the fallback) in tick.test.ts.
 */
import { describe, expect, it } from 'vitest'
// Read through Vite's raw import rather than node:fs, because the worker tsconfig targets the Workers runtime and carries no Node types.
// @ts-expect-error Vite resolves the ?raw suffix to the file's text; there is no ambient declaration for it in this package.
import MIGRATION from '../../../../../supabase-ops/supabase/migrations/20261029220000_variable_copies_2999.sql?raw'
import { organizationIdFrom } from '../ops-db'
import {
  MAX_VARIABLE_COPIES_PER_SAVE, MAX_VARIABLE_COPY_KEY_BYTES, MAX_VARIABLE_COPY_NAMES, MAX_VARIABLE_COPY_VALUE_BYTES, type VariableCopy,
} from '../ops-writes'
import { COPIES_STALE_AFTER_MS } from '../tick'
import { GATEWAY_DEADLINE_MS } from '../tick-live'
import { VARIABLE_COPY_REFRESH_DEADLINE_MS, copyInputOf, copySourceOf, judgeCopy } from '../variable-copies'

describe('the refresh\'s one deadline (#3034)', () => {
  it('is one gateway call\'s, so the refresh never holds a tick longer than a single request to the bidding Worker could', () => {
    expect(VARIABLE_COPY_REFRESH_DEADLINE_MS).toBe(GATEWAY_DEADLINE_MS)
  })
})

describe('the database and the Worker agree on the copy\'s numbers', () => {
  it('the purge deletes at the age a fallback refuses, and the save holds the bounds copyInputOf checks first', () => {
    const hours = /now\(\) - interval '(\d+) hours'/.exec(MIGRATION)
    expect(hours, 'purge_variable_copies names its age in hours').not.toBeNull()
    expect(Number(hours![1]) * 3_600_000).toBe(COPIES_STALE_AFTER_MS)
    expect(MIGRATION).toContain(`octet_length(e.value) > ${MAX_VARIABLE_COPY_VALUE_BYTES}`)
    expect(MIGRATION).toContain(`cardinality(v_names), 0) > ${MAX_VARIABLE_COPY_NAMES}`)
    expect(MIGRATION).toContain(`octet_length(n) > ${MAX_VARIABLE_COPY_KEY_BYTES}`)
    expect(MIGRATION).toContain(`jsonb_array_length(p_copies) > ${MAX_VARIABLE_COPIES_PER_SAVE}`)
  })
})

const ORG = organizationIdFrom('6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60')
const WF = '00000000-0000-4000-8000-0000000029a1'
const PLANTED = 'fake-copy-planted-secret'
const SIX_HOURS = 6 * 60 * 60 * 1000

const served = (values: Record<string, string>, secretKeys: string[] = []) => ({
  workflowId: WF, versionNumber: 3, values, secretKeys, servedAt: '2026-10-29T10:00:00.000Z',
})

describe('a copy entry (copyInputOf)', () => {
  it('keeps each plain value, each secret by NAME only, and names absent each name the version reads that bidding did not serve', () => {
    const input = copyInputOf(ORG, served({ API_BASE: 'https://a.example.test' }, ['API_TOKEN']), ['API_BASE', 'API_TOKEN', 'GONE'])
    expect(input).toEqual({
      organizationId: ORG, workflowId: WF, versionNumber: 3, servedAt: '2026-10-29T10:00:00.000Z',
      values: { API_BASE: 'https://a.example.test' }, secretKeys: ['API_TOKEN'], absentKeys: ['GONE'],
    })
  })

  it('a claimed run\'s answer reaches the copy with its secrets by NAME only, before the copy code sees it (#3034)', () => {
    const source = copySourceOf({
      kind: 'served', workflowId: WF, versionNumber: 3, values: { API_BASE: 'a' }, secretValues: { API_TOKEN: PLANTED }, servedAt: '2026-10-29T10:00:00.000Z',
    })
    expect(source).toEqual(served({ API_BASE: 'a' }, ['API_TOKEN']))
    expect(JSON.stringify(source)).not.toContain(PLANTED)
  })

  it('keeps only the names the version reads, so a value bidding served beyond them is not written', () => {
    expect(copyInputOf(ORG, served({ API_BASE: 'a', EXTRA: 'b' }), ['API_BASE'])).toMatchObject({ values: { API_BASE: 'a' }, absentKeys: [] })
  })

  it('writes nothing for a version past the database\'s bounds, rather than failing the whole save', () => {
    expect(copyInputOf(ORG, served({ BIG: 'x'.repeat(MAX_VARIABLE_COPY_VALUE_BYTES + 1) }), ['BIG'])).toBeNull()
    expect(copyInputOf(ORG, served({}), Array.from({ length: MAX_VARIABLE_COPY_NAMES + 1 }, (_, i) => `N${i}`))).toBeNull()
    expect(copyInputOf(ORG, served({}), ['N'.repeat(257)])).toBeNull()
  })
})

describe('when a claimed run may use the copy (judgeCopy)', () => {
  const DB_NOW = '2026-10-29T12:00:00.000Z'
  const copy = (over: Partial<VariableCopy> = {}): VariableCopy => ({
    workflowId: WF, versionNumber: 3, servedAt: '2026-10-29T11:58:00.000Z', confirmedAt: '2026-10-29T11:59:00.000Z',
    values: { API_BASE: 'https://a.example.test' }, secretKeys: [], absentKeys: ['GONE'], dbNow: DB_NOW, ...over,
  })

  it('uses a fresh, complete copy with no secret: its plain values, from the copy, and never a secret', () => {
    expect(judgeCopy(copy(), ['API_BASE', 'GONE'], SIX_HOURS)).toEqual({
      kind: 'use', variables: { source: 'copy', servedAt: '2026-10-29T11:58:00.000Z', values: { API_BASE: 'https://a.example.test' }, secretValues: {} },
    })
  })

  it('a name bidding said is absent is passed on absent, so the run fails it by name as it does today', () => {
    const used = judgeCopy(copy(), ['API_BASE', 'GONE'], SIX_HOURS)
    expect(used.kind === 'use' && Object.hasOwn(used.variables.values, 'GONE')).toBe(false)
  })

  it('refuses a copy as old as the age limit or older, judged on the database clock', () => {
    const atLimit = new Date(Date.parse(DB_NOW) - SIX_HOURS).toISOString()
    expect(judgeCopy(copy({ confirmedAt: atLimit }), ['API_BASE'], SIX_HOURS)).toEqual({ kind: 'refuse', why: expect.stringMatching(/more than 6 hours/) })
    const justInside = new Date(Date.parse(DB_NOW) - SIX_HOURS + 1000).toISOString()
    expect(judgeCopy(copy({ confirmedAt: justInside }), ['API_BASE'], SIX_HOURS).kind).toBe('use')
  })

  it('refuses when the run reads a secret, whose value the copy never holds', () => {
    expect(judgeCopy(copy({ secretKeys: ['API_TOKEN'] }), ['API_BASE', 'API_TOKEN'], SIX_HOURS)).toEqual({ kind: 'refuse', why: expect.stringMatching(/secret variable env\.API_TOKEN/) })
  })

  it('refuses when the run reads a name the copy never asked bidding about, rather than failing it as missing', () => {
    expect(judgeCopy(copy(), ['API_BASE', 'NEVER_ASKED'], SIX_HOURS)).toEqual({ kind: 'refuse', why: expect.stringMatching(/env\.NEVER_ASKED.+never asked/) })
  })

  it('refuses with no copy of the version, or with no definition to tell what the run reads', () => {
    expect(judgeCopy(undefined, ['API_BASE'], SIX_HOURS)).toEqual({ kind: 'refuse', why: expect.stringMatching(/no copy/) })
    expect(judgeCopy(copy(), null, SIX_HOURS)).toEqual({ kind: 'refuse', why: expect.stringMatching(/definition/) })
  })
})
