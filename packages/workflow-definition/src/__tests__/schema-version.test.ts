import { describe, expect, it } from 'vitest'
import { DEFINITION_SCHEMA_VERSION, DEFINITION_SCHEMA_VERSIONS, OLDEST_DEFINITION_SCHEMA_VERSION, readSchemaStamp } from '../index'

// definition_schema_version (#1947, lesson L255): a definition is judged by the
// rules in force at its own stamp, an unstamped one as the oldest version, and a
// stamp newer than this code knows is a named result, never a silent pass.

describe('the definition schema versions', () => {
  it('starts at 1, with the current version the newest one listed', () => {
    expect(OLDEST_DEFINITION_SCHEMA_VERSION).toBe(1)
    expect(DEFINITION_SCHEMA_VERSIONS[0]).toBe(1)
    expect(DEFINITION_SCHEMA_VERSION).toBe(DEFINITION_SCHEMA_VERSIONS[DEFINITION_SCHEMA_VERSIONS.length - 1])
  })

  it('lists the versions in order with no gap, so every stamp up to the current one has rules', () => {
    DEFINITION_SCHEMA_VERSIONS.forEach((v, i) => expect(v).toBe(i + 1))
  })
})

describe('readSchemaStamp', () => {
  it('reads a definition with no stamp as the oldest version, because every row before the stamp is that version', () => {
    expect(readSchemaStamp(undefined)).toEqual({ kind: 'unstamped', version: OLDEST_DEFINITION_SCHEMA_VERSION })
    expect(readSchemaStamp(null)).toEqual({ kind: 'unstamped', version: OLDEST_DEFINITION_SCHEMA_VERSION })
  })

  it('reads a known stamp as itself', () => {
    expect(readSchemaStamp(1)).toEqual({ kind: 'stamped', version: 1 })
  })

  it('names a stamp newer than this code knows, with the newest it does know', () => {
    expect(readSchemaStamp(DEFINITION_SCHEMA_VERSION + 1)).toEqual({
      kind: 'unknown_schema_version',
      stamp: DEFINITION_SCHEMA_VERSION + 1,
      known: DEFINITION_SCHEMA_VERSION,
    })
  })

  it('reads a stamp against the newest version the caller says it knows', () => {
    expect(readSchemaStamp(2, 2)).toEqual({ kind: 'stamped', version: 2 })
    expect(readSchemaStamp(3, 2)).toEqual({ kind: 'unknown_schema_version', stamp: 3, known: 2 })
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', true, {}])('names %s as an invalid stamp rather than comparing it', (stamp) => {
    expect(readSchemaStamp(stamp)).toEqual({ kind: 'invalid_schema_version', stamp })
  })
})
