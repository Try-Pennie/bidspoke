import { describe, expect, it } from 'vitest'
import { deriveRejectReason } from '../lead-sightings'

/**
 * `reject_reason` must hold a reason the engine actually DETERMINED, never the
 * name of whichever node the run happened to end on.
 *
 * Issue #375. The fallback returned `terminal_node_label ?? 'unknown'` whenever
 * there was no winner, so the terminal node's own name was written into a column
 * whose name asserts a rejection. Measured on 7 days of live data (2026-08-14):
 *
 *   116,487  rows carried a reject_reason
 *   116,476  of them were byte-identical to terminal_node_label (99.99%)
 *        11  actually differed, and those are the genuinely derived ones
 *
 * The labels that landed there say it plainly: 3,736 rows read `patch_prospect`,
 * 3,258 read `tp_bid`, and 407 read `patch_prospect_success`, the word "success"
 * stored in `reject_reason`. 23,464 leads with `outcome='successful'` carried one,
 * so any analytics query counting `reject_reason IS NOT NULL` as rejections was
 * wrong by that much in a single week. The issue estimated 17 rows in 48h, having
 * sampled only one label.
 *
 * Nothing is lost by dropping the fallback: `terminal_node_label` is its own
 * column on `lead_sightings` and is exported to Snowflake right beside
 * `reject_reason`, so every consumer that wants the node name already has it.
 *
 * LESSONS L11: a message may claim only what its check actually measured. The
 * fallback measured "which node ended the run" and reported it as "why the lead
 * was rejected".
 */
describe('deriveRejectReason: reasons the engine determined (#375)', () => {
  it('is null when a partner won, because that is a bid and not a rejection', () => {
    expect(deriveRejectReason({ winning_partner_slug: 'tripoint', terminal_node_label: 'tp_bid' })).toBeNull()
  })

  it('reports engine_error on a 5xx, ahead of every other check', () => {
    expect(
      deriveRejectReason({ response_status_code: 500, terminal_node_label: 'create_applicant' }),
    ).toBe('engine_error')
  })

  it('names the filter rule that rejected the lead', () => {
    expect(
      deriveRejectReason({
        terminal_node_type: 'filter',
        terminal_node_handle: 'exit',
        filter_rule_label: 'debt_under_7500',
      }),
    ).toBe('filter:debt_under_7500')
  })

  it('falls back to filter_rejected when the rule has no label', () => {
    expect(deriveRejectReason({ terminal_node_type: 'filter', terminal_node_handle: 'exit' })).toBe('filter_rejected')
  })

  it('reports all_partners_declined when a bid group produced no winner', () => {
    expect(
      deriveRejectReason({ terminal_node_type: 'bid_group', terminal_node_handle: 'no_winner' }),
    ).toBe('all_partners_declined')
  })

  it('reports a code node that surfaced an error sentinel', () => {
    expect(
      deriveRejectReason({
        terminal_node_type: 'code',
        terminal_node_label: 'equifax_credit_report',
        terminal_step_output: { _error: 'boom' },
      }),
    ).toBe('equifax_credit_report')
  })

  it('reports code_error when the failing code node has no label', () => {
    expect(
      deriveRejectReason({ terminal_node_type: 'code', terminal_step_output: { expected: true } }),
    ).toBe('code_error')
  })
})

describe('deriveRejectReason: the terminal node label is not a reason (#375)', () => {
  it('is null when the run simply ended somewhere, rather than naming that node', () => {
    // The 99.99% case. `patch_prospect` is where the run ended, not why anything
    // was rejected, and terminal_node_label already carries it.
    expect(deriveRejectReason({ terminal_node_label: 'patch_prospect' })).toBeNull()
  })

  it('is null for a successful no-bid path, however descriptive its node name', () => {
    // 15,499 rows in a week read `patch_applicant_no_bid`. It reads like a reason
    // and is produced by the identical code path as `patch_prospect_success`, so
    // the engine cannot tell the two apart and must not claim it can.
    expect(deriveRejectReason({ terminal_node_label: 'patch_applicant_no_bid' })).toBeNull()
  })

  it('never reports a node whose own name says the run succeeded', () => {
    expect(deriveRejectReason({ terminal_node_label: 'patch_prospect_success' })).toBeNull()
  })

  it('is null rather than the string "unknown" when there is no label at all', () => {
    // 'unknown' is a value analytics has to special-case; absence is already
    // expressible, and null is what every SQL reader here already handles.
    expect(deriveRejectReason({})).toBeNull()
  })

  it('does not report a code node that ended cleanly, sentinel absent', () => {
    expect(
      deriveRejectReason({
        terminal_node_type: 'code',
        terminal_node_label: 'tp_bid',
        terminal_step_output: { bid: 0 },
      }),
    ).toBeNull()
  })

  it('does not report a filter the lead PASSED through', () => {
    // Only the 'exit' handle is a rejection; the pass handle is the lead
    // continuing, and must not be labelled.
    expect(
      deriveRejectReason({
        terminal_node_type: 'filter',
        terminal_node_handle: 'pass',
        terminal_node_label: 'penny_fit',
      }),
    ).toBeNull()
  })

  it('does not report a bid group that exited by some other handle', () => {
    expect(
      deriveRejectReason({ terminal_node_type: 'bid_group', terminal_node_handle: 'winner', terminal_node_label: 'engine_bids' }),
    ).toBeNull()
  })

  // #2589: the lead validation node rejects with a reason from the one list
  // (LEAD_REJECTION_REASONS). A validate SCRIPT's rejection recorded null here,
  // because a code node ending cleanly carries no sentinel; the node's output
  // names the reason, so the column records it.
  it('records a lead validation rejection by the reason the partner was told', () => {
    expect(
      deriveRejectReason({
        terminal_node_type: 'lead_validation',
        terminal_node_label: 'validate_bidding_and_state',
        terminal_step_output: { valid: false, check_id: 'state', field: 'trigger.payload.state', reason: 'ineligible state' },
      }),
    ).toBe('lead_validation:ineligible state')
  })

  it('records nothing for a lead that passed validation and ended there', () => {
    expect(
      deriveRejectReason({ terminal_node_type: 'lead_validation', terminal_step_output: { valid: true } }),
    ).toBeNull()
  })

  it('does not invent a reason for a validation output that names none', () => {
    expect(deriveRejectReason({ terminal_node_type: 'lead_validation', terminal_step_output: { valid: false } })).toBe('lead_validation:rejected')
  })
})
