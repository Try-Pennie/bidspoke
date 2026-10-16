/**
 * Every timer trigger in a Pipedream export (#1952), the input to the schedule
 * converter's committed fixture. A timer's props are copied whole, so a key the
 * converter does not know reaches it and is refused there rather than being
 * filtered out here; the export redacts configured prop values, but a timer's
 * cron, interval and zone arrive in the clear (measured on the 2026-09-30 export).
 *
 * Regenerate the fixture: node scripts/porting/timer-fixture.ts <export dir>
 */
import { stateOf } from './plan-load.ts'
import type { ExportedProject } from './read-export.ts'

export interface TimerTriggerRecord {
  hashid: string
  /** The trigger's position in the workflow's trigger list. */
  trigger_index: number
  workflow_state: 'on' | 'off'
  disabled: boolean
  props: Record<string, unknown>
}

export function timerTriggers(projects: readonly ExportedProject[]): TimerTriggerRecord[] {
  const out: TimerTriggerRecord[] = []
  for (const w of projects.flatMap((p) => p.workflows)) {
    if (w.workflow === null) continue
    const state = stateOf(w)
    if (state === 'never_deployed') continue
    const triggers = (w.workflow.triggers ?? []) as Array<{ type?: unknown; disabled?: unknown; props?: unknown }>
    triggers.forEach((t, i) => {
      if (t.type !== 'timer') return
      if (t.props === null || typeof t.props !== 'object' || Array.isArray(t.props)) {
        throw new Error(`${w.hashid} trigger ${i} is a timer with no props object`)
      }
      out.push({ hashid: w.hashid, trigger_index: i, workflow_state: state, disabled: t.disabled === true, props: { ...(t.props as Record<string, unknown>) } })
    })
  }
  return out.sort((a, b) => (a.hashid < b.hashid ? -1 : a.hashid > b.hashid ? 1 : a.trigger_index - b.trigger_index))
}
