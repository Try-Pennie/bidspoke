/**
 * Every non-export check's alert wording, asserted together (2026-09-10).
 *
 * On 2026-09-10 the code node log scan's first real finding arrived saying "the
 * affected rows were not exported ... check Snowflake availability and the
 * export credentials", about a line of code in a workflow. The cause was not
 * that check: eleven checks borrowed the shared export alerter without saying
 * what they were about, and the alerter's default is written for the export jobs
 * it was built from.
 *
 * The remedy argument is now required, so a NEW check cannot repeat the
 * omission: `tsc` refuses it. This file guards the other half, that what a check
 * does supply is not itself export wording, which the type cannot see. Each
 * entry is listed by hand because the point is that a person read it (L96 is the
 * opposite risk, and is covered by the compiler here rather than by a registry).
 */
import { describe, it, expect } from 'vitest'
import type { AlertRemedy, TitledRemedy } from '../export-alerts'
import {
  ARCHIVE_INGEST_REMEDY,
  ARCHIVE_READ_FAILED_REMEDY,
  ARCHIVE_SEND_FAILED_REMEDY,
  ARCHIVE_MISCONFIGURED_REMEDY,
  ARCHIVE_REFUSAL_REMEDY,
  ARCHIVE_LAG_REMEDY,
  ARCHIVE_KILLED_REMEDY,
} from '../../archive/alerts'
import { ARCHIVE_BACKLOG_REMEDY } from '../archive-backlog-run'
import {
  ARCHIVE_GATE_AT_RISK_REMEDY,
  ARCHIVE_GATE_COST_REMEDY,
  ARCHIVE_GATE_NOT_CLEANED_UP_REMEDY,
  ARCHIVE_GATE_UNREADABLE_REMEDY,
} from '../archive-gate'
import { ARCHIVE_IDENTITY_REMEDY } from '../archive-identity-check'
import { ARCHIVE_INDEX_REMEDY } from '../archive-index-check'
import { ARCHIVE_SETTINGS_REMEDY } from '../archive-settings-check'
import { ARCHIVE_STANDSTILL_REMEDY } from '../archive-standstill'
import { ARCHIVE_READ_REMEDY } from '../archive-read-health'
import { ARCHIVE_HEADROOM_REMEDY } from '../archive-headroom-check'
import { ARCHIVE_EXPIRY_REMEDY } from '../archive-expiry'
import { LOGPUSH_CHECK_REMEDY } from '../logpush-check'
import { RETENTION_CHECK_REMEDY } from '../retention-check'
import { PAYLOAD_PRINT_REMEDY } from '../payload-print-check'
import { MATRIX_AUDIT_REMEDY } from '../matrix-audit-health'
import {
  PARTNER_RATES_MISMATCH_REMEDY,
  REVENUE_FORMULAS_DISAGREE_REMEDY,
  TRIPOINT_PRICING_MISMATCH_REMEDY,
  TRIPOINT_PRICING_UNREADABLE_REMEDY,
} from '../tripoint-pricing-check'
import { TRIPOINT_DUPLICATE_CODES_REMEDY } from '../tripoint-duplicate-codes-check'
import { LEAD_STATUS_BACKLOG_REMEDY, LEAD_STATUS_BROKEN_REMEDY, LEAD_STATUS_UNCHECKED_REMEDY } from '../lead-status-check'
import { EXPORT_SCHEMA_REMEDY, EXPORT_SCHEMA_UNREADABLE_REMEDY } from '../export-schema-check'
import { BUYER_SALE_DRAIN_REMEDY } from '../buyer-sale-drain'
import { BUYER_OUTCOME_RATE_REMEDY, BUYER_SALES_MISMATCH_REMEDY, BUYER_SALES_UNRESOLVED_REMEDY } from '../buyer-sales-checks'
import { BUYER_SELECT_PARITY_REMEDY } from '../buyer-select-parity'
import { BUYER_OBJECTS_DRILL_REMEDY } from '../buyer-objects-health'
import { ENGINE_SCRIPT_DRIFT_REMEDY } from '../engine-script-drift'
import { CLICK_CHECK_ERRORS_REMEDY, CLICK_PATH_QUIET_REMEDY, CLICK_RECONCILE_REMEDY, CLICK_SEND_REFUSALS_REMEDY } from '../click-path-checks'

const REMEDIES: ReadonlyArray<readonly [string, AlertRemedy]> = [
  ['archive ingest', ARCHIVE_INGEST_REMEDY],
  ['archive read failed', ARCHIVE_READ_FAILED_REMEDY],
  ['archive send failed', ARCHIVE_SEND_FAILED_REMEDY],
  ['archive misconfigured', ARCHIVE_MISCONFIGURED_REMEDY],
  ['archive refusal', ARCHIVE_REFUSAL_REMEDY],
  ['archive lag', ARCHIVE_LAG_REMEDY],
  ['archive killed', ARCHIVE_KILLED_REMEDY],
  ['archive backlog', ARCHIVE_BACKLOG_REMEDY],
  ['archive gate unreadable', ARCHIVE_GATE_UNREADABLE_REMEDY],
  ['archive read index', ARCHIVE_INDEX_REMEDY],
  ['archive identities', ARCHIVE_IDENTITY_REMEDY],
  ['archive settings', ARCHIVE_SETTINGS_REMEDY],
  ['archive standstill', ARCHIVE_STANDSTILL_REMEDY],
  ['archived reads failing', ARCHIVE_READ_REMEDY],
  ['archive headroom', ARCHIVE_HEADROOM_REMEDY],
  ['archive 13 month expiry', ARCHIVE_EXPIRY_REMEDY],
  ['logpush destinations', LOGPUSH_CHECK_REMEDY],
  ['execution retention', RETENTION_CHECK_REMEDY],
  ['code node payload prints', PAYLOAD_PRINT_REMEDY],
  ['salesforce matrix audit', MATRIX_AUDIT_REMEDY],
  ['tripoint duplicate codes', TRIPOINT_DUPLICATE_CODES_REMEDY],
  ['export schema drift', EXPORT_SCHEMA_REMEDY],
  ['export schema unreadable', EXPORT_SCHEMA_UNREADABLE_REMEDY],
  ['buyer sale drain', BUYER_SALE_DRAIN_REMEDY],
  ['buyer sales mismatch', BUYER_SALES_MISMATCH_REMEDY],
  ['buyer sales unresolved', BUYER_SALES_UNRESOLVED_REMEDY],
  ['buyer outcome rate', BUYER_OUTCOME_RATE_REMEDY],
  ['buyer select parity', BUYER_SELECT_PARITY_REMEDY],
  ['buyer objects drill', BUYER_OBJECTS_DRILL_REMEDY],
  ['engine script drift', ENGINE_SCRIPT_DRIFT_REMEDY],
  ['click check errors', CLICK_CHECK_ERRORS_REMEDY],
  ['click path quiet', CLICK_PATH_QUIET_REMEDY],
  ['click send refusals', CLICK_SEND_REFUSALS_REMEDY],
  ['click reconcile', CLICK_RECONCILE_REMEDY],
]

/**
 * Words that belong to the export jobs. `snowflake` is deliberately absent:
 * three of these checks are genuinely about Snowflake settings and identities,
 * and banning the word there would push them into vaguer wording (L347: not
 * using a word is not the same as not making the claim).
 */
/**
 * Remedies that replace the job name with a plain title and carry no framing
 * sentence, so the findings and the title must carry the meaning between them.
 */
const TITLED: ReadonlyArray<readonly [string, TitledRemedy]> = [
  ['tripoint pricing mismatch', TRIPOINT_PRICING_MISMATCH_REMEDY],
  ['tripoint pricing unreadable', TRIPOINT_PRICING_UNREADABLE_REMEDY],
  ['salesforce revenue formulas disagree', REVENUE_FORMULAS_DISAGREE_REMEDY],
  ['partner rates mismatch', PARTNER_RATES_MISMATCH_REMEDY],
  ['lead status backlog', LEAD_STATUS_BACKLOG_REMEDY],
  ['lead status broken', LEAD_STATUS_BROKEN_REMEDY],
  ['lead status unchecked', LEAD_STATUS_UNCHECKED_REMEDY],
  ['archive gate at risk', ARCHIVE_GATE_AT_RISK_REMEDY],
  ['archive gate not cleaned up', ARCHIVE_GATE_NOT_CLEANED_UP_REMEDY],
  ['archive gate cost', ARCHIVE_GATE_COST_REMEDY],
]

const EXPORT_ONLY = ['not exported', 'un-exported', 'unexported', 'analytics in snowflake', 'supabase disk']

describe('every check says what it measured', () => {
  // The other half of this guard, that every remedy the worker declares is
  // LISTED above, reads worker source and so lives in the web guards directory,
  // which worker-guards-placement.test.ts enforces:
  // apps/web/src/lib/__guards__/worker/every-check-remedy-is-reviewed.test.ts

  // The header is the job name followed by the verb, so a verb written about the
  // subject the job name already implies can name the wrong thing. The standstill
  // job is called execution-archive-standstill, and "is not moving" then read as
  // the CHECK being stuck rather than the archive it watches. Asserted on the
  // property that matters, that the header names what is actually stuck, rather
  // than on the whole sentence, which would break on any legitimate rewording
  // (L103, #523).
  it('the standstill header names the archive, not the check watching it', () => {
    expect(ARCHIVE_STANDSTILL_REMEDY.headlineVerb).toBeDefined()
    expect(ARCHIVE_STANDSTILL_REMEDY.headlineVerb?.toLowerCase()).toContain('archive')
  })

  /**
   * Phrases in which a remedy says, in its own words, that nothing broke.
   *
   * Only explicit denials, never an inference from tone: a check whose body says
   * "nothing failed" and whose header says "failed" contradicts itself in two
   * sentences a reader sees together (#1210). On 2026-09-10 the code node log
   * scan's finding arrived headlined "code-node-payload-prints failed" above a
   * paragraph beginning "nothing failed and nothing is missing".
   */
  const DENIES_FAILURE = ['nothing failed', 'nothing is missing', 'nothing was sent']

  for (const [name, remedy] of REMEDIES) {
    it(`${name} does not headline itself as a failure while denying one`, () => {
      const says = remedy.consequence.toLowerCase()
      if (!DENIES_FAILURE.some((p) => says.includes(p))) return
      // The sender's default verb is "failed" and its default noun is "error", so
      // a remedy that says nothing broke has to supply both or it wears them.
      expect(remedy.headlineVerb, `${name} denies a failure, so it must say what it DID instead`).toBeDefined()
      expect(remedy.headlineVerb?.toLowerCase()).not.toContain('fail')
      expect(remedy.itemNoun, `${name} lists findings, not errors`).toBeDefined()
      expect(remedy.itemNoun?.many.toLowerCase()).not.toContain('error')
    })

    it(`${name} does not borrow the export wording`, () => {
      const words = `${remedy.consequence} ${remedy.fixHint}`.toLowerCase()
      for (const wrong of EXPORT_ONLY) expect(words).not.toContain(wrong)
    })

    it(`${name} says something in both sentences`, () => {
      expect(remedy.consequence.trim().length).toBeGreaterThan(40)
      expect(remedy.fixHint.trim().length).toBeGreaterThan(40)
    })
  }

  for (const [name, remedy] of TITLED) {
    it(`${name} titles itself in words, not a job name`, () => {
      expect(remedy.title).toMatch(/ /)
      expect(remedy.title).not.toMatch(/^[a-z0-9-]+$/)
    })

    it(`${name} does not borrow the export wording`, () => {
      const words = `${remedy.title} ${remedy.fixHint ?? ''}`.toLowerCase()
      for (const wrong of EXPORT_ONLY) expect(words).not.toContain(wrong)
    })
  }
})
