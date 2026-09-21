import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WORKER_SRC, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

/**
 * The daily cap object's name is derived in ONE place (#1410, L39, L613).
 *
 * Two worker sites used to build `cap-{slug}-{date}` inline on the UTC day,
 * while every other day the buyer profiles reason about is Eastern. Both now
 * call dailyCapObjectName from lib/daily-cap-name.ts. This guard fails on the
 * next inline copy: any `cap-${` template in worker source outside that one
 * module, and either known call site no longer importing the helper.
 */
const HELPER = 'lib/daily-cap-name.ts'
const CALL_SITES = ['engine/nodes/partner-bid.ts', 'routes/api/partners.ts']

describe('the daily cap object name has one derivation', () => {
  it('no worker source outside the helper builds a cap- name inline', () => {
    const offenders: string[] = []
    for (const file of listTsFiles(WORKER_SRC)) {
      const rel = path.relative(WORKER_SRC, file)
      if (rel === HELPER || rel.includes('__tests__') || rel.endsWith('.test.ts')) continue
      // Strings are kept: the name IS a string template.
      const src = sanitizeSource(readFileSync(file, 'utf8'), { blankStrings: false })
      if (/`cap-\$\{/.test(src)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it('both cap call sites import the helper, so the derivation cannot drift back', () => {
    for (const rel of CALL_SITES) {
      const src = sanitizeSource(readFileSync(path.join(WORKER_SRC, rel), 'utf8'), { blankStrings: false })
      expect(src, rel).toMatch(/import \{[^}]*\bdailyCapObjectName\b[^}]*\} from '[./]*lib\/daily-cap-name'/)
      expect(src, rel).toMatch(/dailyCapObjectName\(/)
    }
  })

  it('the helper exists and derives the Eastern date through the shared clock (L39)', () => {
    const src = readFileSync(path.join(WORKER_SRC, HELPER), 'utf8')
    expect(src).toMatch(/easternParts/)
    expect(src).not.toMatch(/toISOString/)
  })
})
