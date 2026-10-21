/**
 * The settled lead validation designs' own fixture
 * (docs/design/lead-validation-node.fixture.json, #2590), read once and turned
 * into the config the node stores, so the card and panel tests are held to the
 * data Dan chose from rather than to a copy of it.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

interface FixtureRow { field: string; operator: string; value: string }
interface FixtureCheck { label: string; match: 'AND' | 'OR'; reason: string; missing: string; rows: FixtureRow[] }

export interface LeadValidationFixture {
  node: { title: string; id: string; leadIdField: string }
  chosen: number
  reasons: string[]
  missing: { value: string; label: string }[]
  checks: FixtureCheck[]
}

export const LEAD_VALIDATION_FIXTURE = JSON.parse(
  readFileSync(path.resolve(__dirname, '..', '..', '..', '..', '..', 'docs', 'design', 'lead-validation-node.fixture.json'), 'utf8'),
) as LeadValidationFixture

// The fixture says "fail" where the stored choice is `fail_run`.
const STORED_MISSING: Record<string, string> = { reject: 'reject', pass: 'pass', fail: 'fail_run' }

export interface StoredCheck {
  id: string
  label: string
  condition: { logic: 'AND' | 'OR'; groups: { logic: 'AND' | 'OR'; conditions: { field: string; operator: string; value?: unknown }[] }[] }
  reason: string
  on_missing: string
}

/** The fixture's node as stored config: its lead id field and its seven checks. */
export function leadValidationFixtureConfig(): { lead_id_field: string; checks: StoredCheck[] } {
  return {
    lead_id_field: LEAD_VALIDATION_FIXTURE.node.leadIdField,
    checks: LEAD_VALIDATION_FIXTURE.checks.map((c, i) => ({
      id: `check_${i + 1}`,
      label: c.label,
      condition: {
        logic: 'AND',
        groups: [{ logic: c.match, conditions: c.rows.map((r) => (r.value === '' ? { field: r.field, operator: r.operator } : { field: r.field, operator: r.operator, value: r.value })) }],
      },
      reason: c.reason,
      on_missing: STORED_MISSING[c.missing] ?? c.missing,
    })),
  }
}
