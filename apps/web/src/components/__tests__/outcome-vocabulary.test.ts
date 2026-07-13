/**
 * One vocabulary for the execution outcome taxonomy.
 *
 * The executions filter tabs live in a fixed 288px panel, so their labels have
 * to be short ('Success', 'Done'). Everything else that names the same states
 * (the status badge, the dashboard columns, the trigger help copy) used to spell
 * them out ('Successful', 'Completed'), so the app said two different words for
 * one state: you filtered by Done and got rows badged Completed. Every surface
 * now reads its label from OUTCOME_LABELS.
 */
import { describe, it, expect } from 'vitest'
import { OUTCOME_LABELS } from '@/lib/execution-status'
import { STATUS_STYLES } from '../ExecutionStatusBadge'
import { FILTER_TABS } from '../canvas/ExecutionListPanel'

describe('execution outcome vocabulary', () => {
  it('pins the short words the fixed-width filter row is built around', () => {
    expect(OUTCOME_LABELS.successful).toBe('Success')
    expect(OUTCOME_LABELS.completed).toBe('Done')
  })

  it('badges a state with the same word the filter tab uses', () => {
    expect(STATUS_STYLES.completed.label).toBe(OUTCOME_LABELS.completed)
    expect(STATUS_STYLES.degraded.label).toBe(OUTCOME_LABELS.degraded)
    expect(STATUS_STYLES.failed.label).toBe(OUTCOME_LABELS.failed)
  })

  it('labels every filter tab from the shared vocabulary', () => {
    for (const tab of FILTER_TABS) {
      if (tab.key === 'all') continue
      expect(tab.label).toBe(OUTCOME_LABELS[tab.key])
    }
  })
})
