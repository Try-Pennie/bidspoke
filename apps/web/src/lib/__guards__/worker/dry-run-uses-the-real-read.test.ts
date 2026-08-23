/**
 * The archive dry run must exercise the JOB'S read path, not a second one that
 * claims to match it (#866).
 *
 * The whole value of `scripts/dry-run-archive.ts` is that it is the only thing
 * that runs the archive's read against real data; the unit tests all use doubles,
 * so a pass there says nothing about whether an hour of real executions reads and
 * reconciles (L3). That value is entirely lost if the script reimplements a step
 * instead of calling it.
 *
 * It did. It built its own `Map<string, string>` of workflow id to slug, under a
 * comment saying "the organization map, same read the job makes", and handed it
 * to `dispositionFor`, which wants a `Map<string, WorkflowOrganization>`. So
 * `.slug` on a bare string was `undefined` and the tool reported that EVERY
 * execution in the hour belonged to "organization undefined".
 *
 * A diagnostic that lies is worse than one that says nothing: it sent the reader
 * after a tenancy failure in production that was really a type error in the
 * tool. The real tenancy bug underneath it (a constant holding the organization
 * NAME where a slug was compared) was only found once the tool stopped lying.
 *
 * The compiler now sees this directory (tsconfig.scripts.json), which is the
 * primary fix. This guard covers what a compiler cannot: a future edit that
 * type-checks fine while quietly reading the organizations table itself again.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC } from '../../__tests__/_scan-utils'

const SCRIPT = path.join(WORKER_SRC, '..', 'scripts', 'dry-run-archive.ts')
const source = () => readFileSync(SCRIPT, 'utf8')

describe('the archive dry run', () => {
  it('exists, so this guard is asserting something', () => {
    expect(source().length).toBeGreaterThan(0)
  })

  it('gets its organization map from the job"s own loader', () => {
    expect(source()).toMatch(/loadWorkflowOrganizations\(/)
  })

  // The specific reimplementation that produced the false report. Reading the
  // organizations table inside the script is how a parallel read gets
  // reintroduced, and the embed is the recognisable shape of it.
  it('does not read the organizations table itself', () => {
    const code = source()
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
      .join('\n')

    expect(
      code,
      'the dry run is reading organizations directly again, so it can drift from what the job actually does',
    ).not.toMatch(/organizations!workflows_organization_id_fkey/)
  })

  // It is a READ ONLY tool by construction, and that claim is load-bearing:
  // it is pointed at production by hand. Worth pinning alongside, because the
  // edit that reintroduces a write is the same kind of edit as the one above.
  it('still writes nothing', () => {
    const code = source()
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
      .join('\n')

    for (const write of ['.insert(', '.upsert(', '.update(', '.delete(', 'sendArchiveBatch', 'advanceWatermark']) {
      expect(code, `the dry run calls ${write}, and it is supposed to write nothing anywhere`).not.toContain(write)
    }
  })
})

/**
 * The dry run's timings must say they understate production (#989).
 *
 * The script runs on a laptop and pays neither the Worker's per-request latency
 * to Supabase nor the Snowflake send. Measured 2026-08-22: it reported 39
 * seconds for an hour the deployed Worker took 202 to 257 seconds to do. That 39
 * was quoted straight into MAX_HOURS_PER_RUN's justification and produced a cap
 * of 4 that the wall budget stops at 2, so the constant could never fire.
 *
 * The caveat belongs on the TIMING lines only: the memory and size figures the
 * same script reports are measured on the same rows production handles and are
 * trustworthy, so a blanket disclaimer would teach the reader to discount those
 * too.
 */
describe('the dry run labels its timings as a lower bound (#989)', () => {
  const source = readFileSync(SCRIPT, 'utf8')

  it('prints a caveat on every line that reports a duration', () => {
    const timingLines = source
      .split('\n')
      .filter((line) => /console\.log\(`[^`]*\$\{(fetchMs|encodeMs)\}/.test(line))

    expect(timingLines.length, 'no timing lines were found, so this check proves nothing').toBeGreaterThan(0)
    for (const line of timingLines) {
      expect(line, `this timing line carries no caveat: ${line.trim()}`).toMatch(/TIMING_CAVEAT/)
    }
  })

  it('names what the timing excludes, not just that it is approximate', () => {
    // "roughly" would tell the reader nothing about which direction or by how
    // much, and the whole failure was somebody using the number for sizing.
    expect(source).toMatch(/LOWER BOUND/)
    expect(source).toMatch(/no Snowflake send/)
  })

  it('leaves the memory and size figures unqualified', () => {
    const memoryLine = source.split('\n').find((l) => l.includes('MB held at once'))

    expect(memoryLine).toBeDefined()
    expect(memoryLine).not.toMatch(/TIMING_CAVEAT/)
  })
})
