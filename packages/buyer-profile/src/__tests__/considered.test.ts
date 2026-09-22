/**
 * The considered outcome vocabulary (#1412): what the buyer_select node records
 * for each buyer it looked at. One list, one label per member, shared by the
 * engine that writes it and the execution view that reads it, so a new outcome
 * cannot ship without the words a reader sees (L113).
 */
import { describe, expect, it } from 'vitest'
import { CONSIDERED_OUTCOMES, CONSIDERED_OUTCOME_LABELS, MODE_EFFECTIVE_LABELS } from '../vocab'

describe('considered outcomes', () => {
  it('labels every outcome, and nothing else', () => {
    expect(Object.keys(CONSIDERED_OUTCOME_LABELS).sort()).toEqual([...CONSIDERED_OUTCOMES].sort())
    for (const outcome of CONSIDERED_OUTCOMES) expect(CONSIDERED_OUTCOME_LABELS[outcome]).toMatch(/\S/)
  })

  it('labels the three effective modes in plain words', () => {
    expect(Object.keys(MODE_EFFECTIVE_LABELS).sort()).toEqual(['decide_only', 'live', 'report_only'])
  })
})
