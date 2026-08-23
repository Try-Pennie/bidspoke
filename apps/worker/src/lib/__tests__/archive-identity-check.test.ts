/**
 * Verifying what each archive identity can actually do (#914).
 *
 * The least-privilege claim rested on the statements written in a SQL file, not
 * on anything read back from the account. The gap is asymmetric: a MISSING grant
 * fails loudly the first time the archiver runs, while an EXCESSIVE grant never
 * surfaces at all, because the archiver never attempts the thing it should not
 * be permitted to do (L503).
 *
 * So the load-bearing evidence here is not the grant listing, it is the observed
 * refusal: a guard is only real once it has been seen to refuse something (L1).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../export-alerts', () => ({ notifyExportFailure: vi.fn().mockResolvedValue(undefined) }))

import { checkArchiveIdentities, ARCHIVE_IDENTITY_JOB, deleteProbeStatement } from '../archive-identity-check'
import { ARCHIVE_ROLES, ARCHIVE_DATABASE, ARCHIVE_SCHEMA, ARCHIVE_TABLE, type ArchiveIdentity } from '../archive-snowflake'
import { notifyExportFailure } from '../export-alerts'
import { SnowflakeStatementError, type SnowflakeStatementResponse } from '../snowflake'
import type { Env } from '../../index'
import type { SupabaseClient } from '@supabase/supabase-js'

const env = {} as unknown as Env
const supabase = {} as unknown as SupabaseClient
const TABLE = `${ARCHIVE_DATABASE}.${ARCHIVE_SCHEMA}.${ARCHIVE_TABLE}`

function grants(privileges: string[]): SnowflakeStatementResponse {
  return {
    resultSetMetaData: {
      rowType: [
        { name: 'created_on', type: 'text' },
        { name: 'privilege', type: 'text' },
        { name: 'granted_on', type: 'text' },
        { name: 'name', type: 'text' },
      ],
    },
    data: [
      // A schema grant that must NOT be counted as a table privilege.
      ['2026-08-20', 'USAGE', 'SCHEMA', `${ARCHIVE_DATABASE}.${ARCHIVE_SCHEMA}`],
      ...privileges.map((p) => ['2026-08-20', p, 'TABLE', TABLE]),
    ],
  }
}

const secondaryRoles = (value: string): SnowflakeStatementResponse => ({
  resultSetMetaData: { rowType: [{ name: 'CURRENT_SECONDARY_ROLES()', type: 'text' }] },
  data: [[value]],
})

/** How Snowflake actually refuses: HTTP 400 with code 003001. */
const REFUSED = new SnowflakeStatementError(
  'Snowflake 400: {"code":"003001","message":"SQL access control error"}',
  400,
  '003001',
)

/** Snowflake's deliberately ambiguous "does not exist OR not authorized". */
const AMBIGUOUS = new SnowflakeStatementError(
  'Snowflake 400: {"code":"002003","message":"Object does not exist, or operation cannot be performed"}',
  400,
  '002003',
)

/**
 * What no secondary roles actually looks like on the live account, measured on
 * 2026-08-23. The fixtures default to this rather than to an empty string, so a
 * green suite is evidence about the account we have (L48).
 */
const NO_SECONDARY_ROLES = '{"roles":"","value":""}'

interface Behaviour {
  privileges?: string[]
  secondary?: string
  /** What the constant-false DELETE does for this identity. */
  onDelete?: 'allow' | Error
  /** Fails EVERY statement for this identity, however it is asked. */
  onEvery?: Error
}

const HEALTHY: Record<ArchiveIdentity, Behaviour> = {
  writer: { privileges: ['SELECT', 'INSERT', 'UPDATE'], onDelete: REFUSED },
  reader: { privileges: ['SELECT'], onDelete: REFUSED },
  eraser: { privileges: ['SELECT', 'DELETE'], onDelete: 'allow' },
}

function run(over: Partial<Record<ArchiveIdentity, Behaviour>> = {}) {
  const asked: Array<{ identity: string; statement: string }> = []
  const behaviour = { ...HEALTHY, ...over } as Record<ArchiveIdentity, Behaviour>
  return {
    asked,
    result: checkArchiveIdentities(env, supabase, {
      query: async (identity, statement) => {
        asked.push({ identity, statement })
        const b = behaviour[identity]
        if (b.onEvery instanceof Error) throw b.onEvery
        if (statement.startsWith('SHOW GRANTS')) return grants(b.privileges ?? [])
        if (statement.startsWith('SELECT CURRENT_SECONDARY_ROLES')) {
          return secondaryRoles(b.secondary ?? NO_SECONDARY_ROLES)
        }
        if (b.onDelete instanceof Error) throw b.onDelete
        return { data: [['0']] }
      },
    }),
  }
}

function alerted(): string[] {
  return vi
    .mocked(notifyExportFailure)
    .mock.calls.filter((c) => c[1] === ARCHIVE_IDENTITY_JOB)
    .flatMap((c) => c[2] as string[])
}

beforeEach(() => {
  vi.mocked(notifyExportFailure).mockClear()
})

describe('the probe statement', () => {
  it('carries a constant-false predicate, so it can match no row', () => {
    // This runs daily, as an identity that may hold DELETE, against 13 months of
    // unredacted identity data. The predicate is the only thing between a
    // permission check and an erasure.
    expect(deleteProbeStatement()).toBe(`DELETE FROM ${TABLE} WHERE FALSE`)
    expect(deleteProbeStatement()).toMatch(/WHERE FALSE$/)
  })

  it('takes no arguments, so nothing a caller supplies can reach it', () => {
    expect(deleteProbeStatement.length).toBe(0)
  })
})

describe('an account with the split in force', () => {
  it('finds nothing and raises nothing', async () => {
    const { result } = run()

    expect((await result).findings).toEqual([])
    expect(alerted()).toEqual([])
  })

  it('actually attempted a delete as every identity', async () => {
    // The whole value is the attempt. A check that read grants and stopped would
    // be a description of the control rather than the control refusing.
    const { asked, result } = run()
    await result

    const attempts = asked.filter((a) => a.statement.startsWith('DELETE'))
    expect(attempts.map((a) => a.identity).sort()).toEqual(['eraser', 'reader', 'writer'])
  })

  it('asks each role about its OWN grants', async () => {
    const { asked, result } = run()
    await result

    for (const identity of ['writer', 'reader', 'eraser'] as ArchiveIdentity[]) {
      expect(asked).toContainEqual({ identity, statement: `SHOW GRANTS TO ROLE ${ARCHIVE_ROLES[identity]}` })
    }
  })
})

describe('an identity that can destroy archived rows and should not', () => {
  it('is reported on the ATTEMPT, not just on the grant listing', async () => {
    // Grants say SELECT and INSERT only, and the delete runs anyway. Reading the
    // listing alone would report this account as correct.
    const { result } = run({ writer: { privileges: ['SELECT', 'INSERT', 'UPDATE'], onDelete: 'allow' } })

    const findings = (await result).findings
    expect(findings.map((f) => f.code)).toEqual(['delete-allowed'])
    expect(alerted()[0]).toMatch(/writer identity was ALLOWED to run a delete/)
  })

  it('is reported from the grant listing too, when that is where it shows', async () => {
    const { result } = run({ reader: { privileges: ['SELECT', 'DELETE'], onDelete: REFUSED } })

    expect((await result).findings.map((f) => f.code)).toEqual(['grant-excessive'])
  })

  it('reports ownership, which is DELETE under another name', async () => {
    // A listing showing OWNERSHIP and no DELETE reads as least privilege.
    const { result } = run({ writer: { privileges: ['OWNERSHIP'], onDelete: REFUSED } })

    const codes = (await result).findings.map((f) => f.code)
    expect(codes).toContain('grant-ownership')
  })
})

describe('the eraser', () => {
  it('is reported when it CANNOT delete, which is the positive control', async () => {
    // Without this, every assertion above is satisfied by an account where
    // nobody can delete, and the erasure hook and the expiry job would both fail
    // the first time they were needed, months from now (L159).
    const { result } = run({ eraser: { privileges: ['SELECT'], onDelete: REFUSED } })

    const codes = (await result).findings.map((f) => f.code)
    expect(codes).toContain('delete-refused')
    expect(codes).toContain('grant-missing')
  })
})

describe('secondary roles', () => {
  it('are reported, because they make the split circumstantial', async () => {
    // Two of the three were found loose when this was first checked by hand.
    // With secondary roles active, an identity holds whatever any of them holds.
    const { result } = run({ reader: { privileges: ['SELECT'], secondary: 'ALL', onDelete: REFUSED } })

    expect((await result).findings.map((f) => f.code)).toEqual(['secondary-roles'])
  })

  it('does not stringify a value it cannot read into an alert nobody can act on', async () => {
    // An object renders as "[object Object]", which reads as roles being active.
    const asked: Array<string> = []
    const result = await checkArchiveIdentities(env, supabase, {
      query: async (identity, statement) => {
        asked.push(statement)
        if (statement.startsWith('SHOW GRANTS')) return grants(HEALTHY[identity].privileges ?? [])
        if (statement.startsWith('SELECT CURRENT_SECONDARY_ROLES')) {
          return { resultSetMetaData: { rowType: [{ name: 'r', type: 'text' }] }, data: [[{ nested: true }]] }
        }
        if (identity === 'eraser') return { data: [['0']] }
        throw REFUSED
      },
    })

    expect(result.findings.map((f) => f.code)).toEqual(['unreadable', 'unreadable', 'unreadable'])
    expect(result.findings[0].message).not.toMatch(/object Object/)
  })

  it('accepts the spellings Snowflake uses for none of them', async () => {
    for (const value of ['', 'NULL', '[]', 'none']) {
      vi.mocked(notifyExportFailure).mockClear()
      const { result } = run({ reader: { privileges: ['SELECT'], secondary: value, onDelete: REFUSED } })
      expect((await result).findings, `"${value}" was read as roles being active`).toEqual([])
    }
  })
})

describe("Snowflake's ambiguous refusal", () => {
  it('is read as a refusal when another identity reached the table in the same run', async () => {
    // 002003 means "does not exist OR not authorized", so on its own it proves
    // nothing. The eraser deleting successfully proves the table exists and is
    // reachable, so the reader's ambiguous answer can only be the authorization
    // half. A real inference from evidence collected here, not an assumption.
    const { result } = run({ reader: { privileges: ['SELECT'], onDelete: AMBIGUOUS } })

    expect((await result).findings).toEqual([])
  })

  it('stays unresolved when nothing reached the table, rather than being called a refusal', async () => {
    // Every identity ambiguous is what a MISSING TABLE looks like, and calling
    // that a working permission model would report the control as verified when
    // there is nothing to protect (L11).
    const { result } = run({
      writer: { privileges: ['SELECT', 'INSERT'], onDelete: AMBIGUOUS },
      reader: { privileges: ['SELECT'], onDelete: AMBIGUOUS },
      eraser: { privileges: ['SELECT', 'DELETE'], onDelete: AMBIGUOUS },
    })

    const findings = (await result).findings
    expect(findings.every((f) => f.code === 'unreadable')).toBe(true)
    expect(findings).toHaveLength(3)
    expect(findings[0].message).toMatch(/cannot be told apart/)
  })
})

describe('when a read fails', () => {
  it('does not read a non-permission failure as a refusal', async () => {
    // A sleeping warehouse has established nothing about permissions, and
    // reading it as a refusal would report the control as verified during an
    // outage (L11).
    const { result } = run({ writer: { privileges: ['SELECT', 'INSERT'], onDelete: new Error('warehouse suspended') } })

    const findings = (await result).findings
    expect(findings.map((f) => f.code)).toEqual(['unreadable'])
    expect(alerted()[0]).toMatch(/for a reason other than permissions/)
  })

  it('still attempts the delete when the grant listing failed', async () => {
    // The probe is the only observed evidence this check collects, so stopping
    // at the first error would skip the thing that matters.
    const asked: Array<{ identity: string; statement: string }> = []
    await checkArchiveIdentities(env, supabase, {
      query: async (identity, statement) => {
        asked.push({ identity, statement })
        if (statement.startsWith('SHOW GRANTS')) throw new Error('cannot show grants')
        if (statement.startsWith('SELECT CURRENT_SECONDARY_ROLES')) return secondaryRoles('')
        if (identity === 'eraser') return { data: [['0']] }
        throw REFUSED
      },
    })

    expect(asked.filter((a) => a.statement.startsWith('DELETE'))).toHaveLength(3)
  })
})

describe('an identity whose credential is not set', () => {
  /** What the Worker throws before any request leaves, when the secret is absent. */
  const NOT_SET = new Error('ARCHIVE_READER_USER is not set, so the archive cannot authenticate to Snowflake')

  it('is reported once, not once per thing the check tried to read', async () => {
    // On 2026-08-23 two unset credentials produced SIX alert lines, three per
    // identity, each naming the same missing secret. One cause must read as one
    // cause: a reader counting lines cannot tell six problems from one, and the
    // repetition buried the single genuine finding in the same alert.
    const { result } = run({ reader: { onEvery: NOT_SET } })
    const readerFindings = (await result).findings.filter((f) => f.identity === 'reader')

    expect(readerFindings).toHaveLength(1)
    expect(readerFindings[0].message).toContain('ARCHIVE_READER_USER is not set')
  })

  it('still reports each cause separately when the reads fail for DIFFERENT reasons', async () => {
    // The collapse must key on the causes being the SAME. Two genuinely
    // different failures are two things to look at, and folding them together
    // would hide one of them (L11).
    const { result } = run({
      reader: {
        privileges: ['SELECT'],
        secondary: 'a shape nothing can read',
        onDelete: new Error('the warehouse could not resume'),
      },
    })
    const readerFindings = (await result).findings.filter((f) => f.identity === 'reader')

    expect(readerFindings).toHaveLength(2)
  })
})
