/**
 * The ordering obligation soft delete puts on the API_KEY_MAP rebuild
 * (#877 Phase B0, #883).
 *
 * `rebuildKeyMap` in the worker's sources route derives the live `API_KEY_MAP`
 * Cloudflare secret from `api_sources` on every mutation of the Sources page.
 * The select has no lifecycle filter, which is harmless only for as long as a
 * delete actually removes the row.
 *
 * The moment `api_sources` gains `deleted_at`, the unfiltered select returns
 * tombstoned rows, so the next mutation merges a revoked partner API key back
 * into the live secret and re-authorises a source somebody deliberately cut off.
 * A revoked credential returning to production with nobody acting is a security
 * regression handed over by a data-safety feature.
 *
 * The filter cannot simply be shipped ahead of the column: PostgREST answers
 * 42703 for a column that does not exist (confirmed against prod on 2026-08-21),
 * so a premature `.is('deleted_at', null)` would fail every rebuild rather than
 * protect anything. So the ordering is enforced instead of promised, and it is
 * keyed on the GENERATED database types rather than on a hand-kept list: the
 * pre-merge gate already fails a schema migration that ships without
 * regenerating them, so a new column cannot reach main without passing here
 * (L41).
 *
 * The behavioural half of #877 (a failed read must not write a map at all) lives
 * in the worker suite, at routes/api/__tests__/key-map-integrity.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKER_SRC } from '../../__tests__/_scan-utils'

const SOURCES = join(WORKER_SRC, 'routes/api/sources.ts')
const DB_TYPES = join(WORKER_SRC, 'types/database.ts')

/** The `api_sources` block of the generated types, which mirrors the schema. */
function apiSourcesTypes(): string {
  const types = readFileSync(DB_TYPES, 'utf8')
  const marker = '      api_sources: {'
  const start = types.indexOf(marker)
  expect(start, 'api_sources is missing from the generated database types').toBeGreaterThan(-1)
  const rest = types.slice(start + marker.length)
  // Stop at the next table declared at the same indentation.
  const end = rest.search(/\n {6}\w+: \{\n {8}Row: \{/)
  return end === -1 ? rest : rest.slice(0, end)
}

/** The body of rebuildKeyMap, so a `deleted_at` elsewhere in the file cannot answer for it. */
function rebuildKeyMapBody(): string {
  const source = readFileSync(SOURCES, 'utf8')
  const start = source.indexOf('async function rebuildKeyMap(')
  expect(start, 'rebuildKeyMap not found in worker sources.ts').toBeGreaterThan(-1)
  const rest = source.slice(start)
  const end = rest.indexOf('\n}')
  expect(end, 'could not find the end of rebuildKeyMap').toBeGreaterThan(-1)
  return rest.slice(0, end)
}

describe('api_sources soft delete and the live key map', () => {
  // Scoping the search to the function body rather than the whole file is the
  // point: a guard that greps a whole file is answered by any occurrence in it,
  // so an unrelated `deleted_at` in another route in the same file would satisfy
  // it while the rebuild stayed broken (L135).
  it('requires the filter in rebuildKeyMap as soon as api_sources gains deleted_at', () => {
    const hasColumn = /\n {10}deleted_at\??:/.test(apiSourcesTypes())
    const filtersIt = /deleted_at/.test(rebuildKeyMapBody())

    if (hasColumn) {
      expect(
        filtersIt,
        'api_sources now has deleted_at, so rebuildKeyMap must exclude tombstoned rows. Without the ' +
          'filter, the next mutation on the Sources page writes a revoked API key back into the live ' +
          'API_KEY_MAP secret and re-authorises a source that was deliberately cut off.',
      ).toBe(true)
    } else {
      // Not a vacuous pass: it records that the column is absent TODAY and that
      // the filter is absent for a measured reason, so the next reader can tell
      // a deliberate wait from an oversight (L182).
      expect(filtersIt).toBe(false)
    }
  })

  // removeKeys is the only thing that revokes a key before the row is gone, so
  // it has to survive whatever the read-side filter ends up doing.
  it('keeps revoking deleted keys explicitly rather than relying on the read alone', () => {
    expect(rebuildKeyMapBody()).toMatch(/removeKeys/)
  })

  // The behavioural fix has a home, and this says where, so removing it is a
  // visible act rather than a quiet one.
  it('keeps the failed-read path covered in the worker suite', () => {
    const worker = readFileSync(join(WORKER_SRC, 'routes/api/__tests__/key-map-integrity.test.ts'), 'utf8')
    expect(worker).toMatch(/does not write a key map at all/)
  })
})
