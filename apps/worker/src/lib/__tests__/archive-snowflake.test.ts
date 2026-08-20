import { describe, it, expect } from 'vitest'
import {
  ARCHIVE_DATABASE,
  ARCHIVE_SCHEMA,
  ARCHIVE_WAREHOUSE,
  ARCHIVE_TABLE,
  ARCHIVE_ROLES,
  archiveConfig,
  verifyArchiveIdentity,
  resolveIdentity,
} from '../archive-snowflake'
import { REQUIRED_SECRETS } from '../required-secrets'
import type { Env } from '../../index'

// Deliberately NOT shaped like a PEM. Nothing here parses the key, archiveConfig
// only requires it to be non-empty, and a realistic private key header in a
// committed fixture is flagged by the repo's secret scanner, which is the scanner
// working correctly: it cannot tell a fake key from a real one.
const FAKE_KEY_MATERIAL = 'test-key-material-not-a-real-key'

function envWith(overrides: Record<string, string | undefined> = {}): Env {
  const base: Record<string, string | undefined> = {
    SNOWFLAKE_ACCOUNT: 'jyc55588.us-east-1',
    ARCHIVE_WRITER_USER: 'bidspoke_archive_writer_svc',
    ARCHIVE_WRITER_PRIVATE_KEY: FAKE_KEY_MATERIAL,
    ARCHIVE_READER_USER: 'bidspoke_archive_reader_svc',
    ARCHIVE_READER_PRIVATE_KEY: FAKE_KEY_MATERIAL,
    ARCHIVE_ERASER_USER: 'bidspoke_archive_eraser_svc',
    ARCHIVE_ERASER_PRIVATE_KEY: FAKE_KEY_MATERIAL,
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete base[k]
    else base[k] = v
  }
  return base as unknown as Env
}

describe('archiveConfig', () => {
  it('takes the destination from constants, not from configuration', () => {
    const config = archiveConfig(envWith(), 'writer')

    expect(config.database).toBe(ARCHIVE_DATABASE)
    expect(config.schema).toBe(ARCHIVE_SCHEMA)
    expect(config.warehouse).toBe(ARCHIVE_WAREHOUSE)
    expect(config.role).toBe(ARCHIVE_ROLES.writer)
    expect(config.user).toBe('bidspoke_archive_writer_svc')
  })

  it('gives each identity its own role', () => {
    expect(archiveConfig(envWith(), 'reader').role).toBe(ARCHIVE_ROLES.reader)
    expect(archiveConfig(envWith(), 'eraser').role).toBe(ARCHIVE_ROLES.eraser)
  })

  // Two secrets per identity, and a message that names only "the archive
  // credentials" cannot tell someone which of the two they failed to set
  // (L11: distinct causes get distinct messages).
  it('names the missing user secret specifically', () => {
    expect(() => archiveConfig(envWith({ ARCHIVE_WRITER_USER: undefined }), 'writer'))
      .toThrow(/ARCHIVE_WRITER_USER/)
  })

  it('names the missing private key secret specifically, and does not blame the user secret', () => {
    let message = ''
    try {
      archiveConfig(envWith({ ARCHIVE_WRITER_PRIVATE_KEY: undefined }), 'writer')
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toMatch(/ARCHIVE_WRITER_PRIVATE_KEY/)
    expect(message).not.toMatch(/ARCHIVE_WRITER_USER/)
  })

  it('names the shared account secret when it is the one missing', () => {
    expect(() => archiveConfig(envWith({ SNOWFLAKE_ACCOUNT: undefined }), 'writer'))
      .toThrow(/SNOWFLAKE_ACCOUNT/)
  })

  it('treats an empty secret as missing, since an unset Worker secret can arrive as an empty string', () => {
    expect(() => archiveConfig(envWith({ ARCHIVE_ERASER_PRIVATE_KEY: '' }), 'eraser'))
      .toThrow(/ARCHIVE_ERASER_PRIVATE_KEY/)
  })
})

describe('verifyArchiveIdentity', () => {
  it('reports the row count it actually read back', async () => {
    const result = await verifyArchiveIdentity(envWith(), 'writer', {
      execute: async () => ({ data: [['7']], resultSetMetaData: { numRows: 1 } }),
    })

    expect(result.ok).toBe(true)
    expect(result.rowCount).toBe(7)
  })

  // The trap this exists for: an error message quotes the thing it failed on,
  // so a success check that looks for the table name in the response is
  // satisfied by the failure about that table (L156).
  it('refuses a response that merely mentions the archive table', async () => {
    const result = await verifyArchiveIdentity(envWith(), 'writer', {
      execute: async () => ({
        message: `SQL access control error: Insufficient privileges to operate on table '${ARCHIVE_TABLE}'`,
        code: '003001',
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/Insufficient privileges/)
  })

  it('refuses a response carrying no value at all rather than reporting zero rows', async () => {
    const result = await verifyArchiveIdentity(envWith(), 'writer', {
      execute: async () => ({ data: [] }),
    })

    expect(result.ok).toBe(false)
    expect(result.rowCount).toBeUndefined()
    expect(result.reason).toMatch(/no count/i)
  })

  it('reports the identity and role it authenticated as, so a wrong one is visible', async () => {
    const result = await verifyArchiveIdentity(envWith(), 'reader', {
      execute: async () => ({ data: [['0']], resultSetMetaData: { numRows: 1 } }),
    })

    expect(result.identity).toBe('reader')
    expect(result.role).toBe(ARCHIVE_ROLES.reader)
  })
})

// The other four archive secrets stay OUT until the reader and eraser code paths
// ship: REQUIRED_SECRETS alerts every org's Slack daily, so registering a secret
// nothing has set yet pages every morning for nothing (#870).
describe('the archive secrets the daily check knows about', () => {
  it('covers exactly the two the writer reads', () => {
    const archiveSecrets = REQUIRED_SECRETS.filter((name) => name.startsWith('ARCHIVE_'))
    expect(archiveSecrets).toEqual(['ARCHIVE_WRITER_USER', 'ARCHIVE_WRITER_PRIVATE_KEY'])
  })
})

describe('resolveIdentity', () => {
  it('defaults to the writer when no identity is named', () => {
    expect(resolveIdentity([])).toBe('writer')
    expect(resolveIdentity(['--check-delete'])).toBe('writer')
  })

  it('takes the identity that was named', () => {
    expect(resolveIdentity(['eraser'])).toBe('eraser')
    expect(resolveIdentity(['reader', '--check-delete'])).toBe('reader')
  })

  // The failure this exists for: falling back to the writer on a typo verifies
  // an identity nobody asked about and prints a pass, so someone checking the
  // eraser would be told the eraser is fine on the strength of the writer
  // (L75: when identifying the target fails, refuse rather than act on a
  // nearby candidate).
  it('refuses a misspelled identity rather than falling back to the writer', () => {
    expect(() => resolveIdentity(['eraserr'])).toThrow(/eraserr/)
    expect(() => resolveIdentity(['eraserr'])).toThrow(/writer, reader, eraser/)
  })

  it('refuses an unknown flag rather than reading it as an identity', () => {
    expect(() => resolveIdentity(['--chekc-delete'])).toThrow(/--chekc-delete/)
  })
})
