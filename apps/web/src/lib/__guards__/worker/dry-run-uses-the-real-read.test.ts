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
