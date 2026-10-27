/**
 * What the daily Step Timeout Warnings line says about an under-provisioned step
 * (2026-10-27). It said "most runs would time out" for every step it paged on,
 * but it pages only on severity red, which means the configured timeout is below
 * the slowest run when the step has no retries, and below the p99 when it has
 * some (timeoutSeverity). Neither is "most runs": the 2026-10-27 04:17 ET alert
 * said it of Main Flow's Send Salesforce at 4,500 ms with a p99 of 2,891 ms, when
 * 1 of its 1,020 runs had taken longer than 4,500 ms. The line must say what was
 * measured.
 */
import { describe, it, expect } from 'vitest'
import { underProvisionedLine } from '../slack'
import { findUnderProvisionedNodes, isAlertWorthyUnderProvision } from '../timeout-audit'
import type { WorkflowDefinition } from '../../types'

const URL = 'https://bidspoke.example/workflows/wf?node=n1'

/** The 2026-10-27 alert's node, as the audit measured it: retries 0, max from the slowest of 1,020 runs. */
const sendSalesforce = {
  node_id: 'n1',
  label: 'Send Salesforce',
  namespace: 'send_salesforce',
  type: 'salesforce',
  configured_ms: 4500,
  suggested_ms: 5250,
  p99_ms: 2891,
  max_ms: 4765,
  sample_size: 1020,
  retries: 0,
  severity: 'red' as const,
}

describe('the under-provisioned line says what was measured', () => {
  it('a step with no retries is below its slowest run, never "most runs would time out"', () => {
    const line = underProvisionedLine(sendSalesforce, URL)
    expect(line).not.toContain('most runs')
    expect(line).toBe(
      `• <${URL}|Send Salesforce> (salesforce): set to 4,500ms with no retries, and its slowest of 1,020 recent runs took 4,765ms, so a run that slow fails. Try 5,250ms (p99 2,891ms).`,
    )
  })

  it('a step with retries is below its p99, so more than 1 run in 100 takes longer and retries', () => {
    const line = underProvisionedLine({ ...sendSalesforce, configured_ms: 2500, suggested_ms: 4500, retries: 2 }, URL)
    expect(line).not.toContain('most runs')
    expect(line).toBe(
      `• <${URL}|Send Salesforce> (salesforce): set to 2,500ms, below the p99 of 2,891ms over 1,020 recent runs, so more than 1 run in 100 takes longer and is retried. Try 4,500ms.`,
    )
  })

  it('the audit hands the line the retries it judged severity by', () => {
    const def = {
      id: 'wf', name: 'wf', trigger: {}, edges: [],
      nodes: [{ id: 'n1', namespace: 'send_salesforce', type: 'salesforce', label: 'Send Salesforce', config: { timeout_ms: 4500, retries: 0 } }],
    } as unknown as WorkflowDefinition
    const [n] = findUnderProvisionedNodes(def, new Map([['send_salesforce', { p99: 2891, max_ms: 4765, sample_size: 1020, window_days: 1 }]]))
    expect(n).toMatchObject({ retries: 0, severity: 'red', suggested_ms: 5250 })
    expect(isAlertWorthyUnderProvision(n)).toBe(true)
  })
})
