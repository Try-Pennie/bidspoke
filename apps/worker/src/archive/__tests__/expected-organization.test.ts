/**
 * The archive's tenancy constant is a SLUG, and must hold a slug (#866).
 *
 * `EXPECTED_ORGANIZATION_SLUG` held `trypennie.com`. The organization's slug is
 * `trypennie-com`. `trypennie.com` is its NAME. The two differ by one character,
 * both look correct to a reader, and `dispositionFor` compares against
 * `organization.slug`, so every execution in production was refused as belonging
 * to the wrong tenant. Measured by a dry run against the real database: 5,617 of
 * 5,617 executions in one hour refused, 0 archived.
 *
 * This was the third of three independent bugs that each, alone, stopped the
 * archive backing up anything: the status vocabulary (#929), the initial
 * watermark (#945), and this.
 *
 * A constant named for one column and populated from another is invisible
 * (L176), so the fixture records BOTH columns and this suite asserts the
 * constant equals the slug and specifically does NOT equal the name. Asserting
 * only the value would be satisfied by whichever string somebody pasted in next.
 */
import { describe, it, expect } from 'vitest'
import { A_V7_EXECUTION_ID } from './_ids'
import { dispositionFor, EXPECTED_ORGANIZATION_SLUG, ARCHIVABLE_ORGANIZATION_SLUGS } from '../disposition'
import { SETTLE_WINDOW_MS } from '../clock'
import orgs from '../fixtures/organizations.json'

const live = orgs.organizations.find((o) => o.note.includes('has ever produced an execution'))
const HOUR_START = '2026-08-18T10:00:00.000Z'
const settled = new Date(Date.parse(HOUR_START) + SETTLE_WINDOW_MS + 60_000)

describe('EXPECTED_ORGANIZATION_SLUG', () => {
  it('is the live organization"s slug', () => {
    expect(live, 'the fixture names no live organization').toBeDefined()
    expect(EXPECTED_ORGANIZATION_SLUG).toBe(live?.slug)
  })

  // The actual defect, asserted as its own case. The two values differ by one
  // character and the failure mode is total, so it is worth its own test rather
  // than being implied by the one above.
  it('is not the organization"s NAME, which differs by one character', () => {
    expect(live?.name).not.toBe(live?.slug)
    expect(EXPECTED_ORGANIZATION_SLUG).not.toBe(live?.name)
  })

  it('is slug-shaped: no dots, which is what tells the two apart here', () => {
    expect(EXPECTED_ORGANIZATION_SLUG).not.toMatch(/\./)
    expect(EXPECTED_ORGANIZATION_SLUG).toMatch(/^[a-z0-9-]+$/)
  })
})

describe('the tenancy check against the real organizations', () => {
  const organizationOf = new Map(
    orgs.organizations.map((o) => [`wf-${o.slug}`, { id: o.id, slug: o.slug }]),
  )
  const execution = (workflowId: string) => ({
    id: A_V7_EXECUTION_ID,
    workflow_id: workflowId,
    status: 'completed',
    started_at: HOUR_START,
  })

  // The end-to-end statement of the bug: with the real slugs, the live org's
  // executions must be archived, not refused.
  it('archives an execution from the live organization', () => {
    const d = dispositionFor(execution(`wf-${live?.slug}`), { now: settled, organizationOf })

    expect(d.action, d.reason).toBe('archive')
  })

  // Reversed on 2026-09-23 (#1486). This case used to assert the e2e org was
  // refused. Its first execution, a manual Test run, was refused and left its
  // day undeletable, because the gate needs both stores' counts to agree. Every
  // archive read filters on organization_id, which ADR 0009 names as the
  // boundary, and this org holds only our own test runs, so it is archived.
  it('archives an execution from the e2e test organization', () => {
    const e2e = orgs.organizations.find((o) => o.slug === 'e2e-test')
    expect(e2e, 'the fixture names no e2e organization').toBeDefined()
    const d = dispositionFor(execution(`wf-${e2e?.slug}`), { now: settled, organizationOf })

    expect(d.action, d.reason).toBe('archive')
  })

  it('accepts exactly the organizations in the fixture, by slug', () => {
    expect([...ARCHIVABLE_ORGANIZATION_SLUGS].sort()).toEqual(orgs.organizations.map((o) => o.slug).sort())
  })

  // The exemption is a slug, never the name, for the same reason as the live
  // org above: the name 'E2E Test' must not be what unlocks it.
  it('does not accept the e2e organization by its NAME', () => {
    const d = dispositionFor(execution('wf-by-name'), {
      now: settled,
      organizationOf: new Map([['wf-by-name', { id: 'x', slug: 'E2E Test' }]]),
    })

    expect(d.action).toBe('refuse')
  })
})
