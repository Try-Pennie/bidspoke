import { describe, expect, it } from 'vitest'
import { readExport } from '../read-export.ts'
import { timerTriggers } from '../timers.ts'
import { workflowFile, writeExport } from './fixture.ts'

describe('timerTriggers (#1952)', () => {
  const projects = () => readExport(writeExport([{
    projectHashid: 'proj_A',
    workflows: [
      { hashid: 'p_b', file: workflowFile('p_b', { triggers: [{ type: 'http' }, { type: 'timer', props: { cron: '0 8 * * 1-5', timezone: 'America/New_York' }, runtime: { id: 'ti_x' } }] }) },
      { hashid: 'p_a', file: workflowFile('p_a', { inactive: true, triggers: [{ type: 'timer', disabled: true, props: { interval_seconds: 2700, timezone: 'UTC' } }] }) },
      { hashid: 'p_http', file: workflowFile('p_http', { triggers: [{ type: 'http' }] }) },
      { hashid: 'p_never', status: 'skipped_never_deployed' },
    ],
  }]))

  it('lists every timer trigger with its index, workflow state, disabled flag and props, sorted, and nothing else', () => {
    expect(timerTriggers(projects())).toEqual([
      { hashid: 'p_a', trigger_index: 0, workflow_state: 'off', disabled: true, props: { interval_seconds: 2700, timezone: 'UTC' } },
      { hashid: 'p_b', trigger_index: 1, workflow_state: 'on', disabled: false, props: { cron: '0 8 * * 1-5', timezone: 'America/New_York' } },
    ])
  })

  it('refuses a timer with no props object rather than listing it empty', () => {
    const bad = readExport(writeExport([{ projectHashid: 'proj_A', workflows: [{ hashid: 'p_c', file: workflowFile('p_c', { triggers: [{ type: 'timer' }] }) }] }]))
    expect(() => timerTriggers(bad)).toThrow(/p_c trigger 0 is a timer with no props/)
  })
})
