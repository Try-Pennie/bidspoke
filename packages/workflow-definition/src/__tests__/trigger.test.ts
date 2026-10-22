import { describe, expect, it } from 'vitest'
import { PLANNED_TRIGGER_TYPES, TRIGGER_LANES, TRIGGER_TYPES, validateTrigger, type TriggerConfig } from '../index'

// The TriggerConfig union (#1947): the trigger types that exist, the lanes each
// one runs in, and the ones the plan names that nothing can run yet, refused by
// name rather than read as garbage.

const http = (config: Record<string, unknown> = {}) => ({ type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key', ...config } })
const schedule = (config: Record<string, unknown> = {}) => ({
  type: 'schedule',
  config: { cron: '0 9 * * MON', timezone: 'America/New_York', overlap: 'skip', catch_up: 'none', jitter_max_seconds: 0, ...config },
})
const reasons = (trigger: unknown, lane: 'money' | 'ops') => validateTrigger(trigger, lane).map((p) => p.reason)

describe('the trigger types', () => {
  it('runs an http webhook on both lanes and a schedule on the ops lane only', () => {
    expect(TRIGGER_LANES).toEqual({ http_webhook: ['money', 'ops'], schedule: ['ops'] })
    expect([...TRIGGER_TYPES].sort()).toEqual(Object.keys(TRIGGER_LANES).sort())
  })

  it('keeps the planned types out of the runnable list', () => {
    for (const planned of PLANNED_TRIGGER_TYPES) expect(TRIGGER_TYPES as readonly string[]).not.toContain(planned)
  })

  it('types a schedule trigger with the schedule shape the ops tick reads', () => {
    const trigger: TriggerConfig = { type: 'schedule', config: { interval_seconds: 300, timezone: 'UTC', overlap: 'queue', catch_up: 'none', jitter_max_seconds: 0 } }
    expect(validateTrigger(trigger, 'ops')).toEqual([])
  })
})

describe('validateTrigger', () => {
  it('passes the http webhook every stored workflow carries, on both lanes', () => {
    expect(validateTrigger(http(), 'money')).toEqual([])
    expect(validateTrigger(http(), 'ops')).toEqual([])
  })

  it('passes every optional http field in the shape stored rows hold, and ignores a key nothing reads', () => {
    const full = http({
      idempotency: { enabled: true, derive_from_fields: ['email'], ttl_seconds: 60 },
      duration_alert_ms: 50000,
      success_node_namespaces: ['done'],
      muted_failure_signals: [{ match: 'ACRO_GATEWAY', count: 3, window_minutes: 5 }],
      custom_response: { anything: true },
    })
    expect(validateTrigger(full, 'money')).toEqual([])
  })

  it('refuses a schedule on the money lane by name, because nothing on the money lane fires one', () => {
    const problems = validateTrigger(schedule(), 'money')
    expect(problems.map((p) => [p.reason, p.severity])).toEqual([['trigger_not_on_lane', 'error']])
    expect(problems[0].message).toContain('money')
  })

  it('passes a valid schedule on the ops lane and names the schedule refusal of an invalid one', () => {
    expect(validateTrigger(schedule(), 'ops')).toEqual([])
    const problems = validateTrigger(schedule({ overlap: 'sometimes' }), 'ops')
    expect(problems.map((p) => p.reason)).toEqual(['trigger_config_invalid'])
    expect(problems[0].detail).toBe('overlap_invalid')
  })

  it('refuses every planned type by name on both lanes, not as an unknown type', () => {
    for (const type of PLANNED_TRIGGER_TYPES) {
      for (const lane of ['money', 'ops'] as const) {
        const problems = validateTrigger({ type, config: {} }, lane)
        expect(problems.map((p) => p.reason)).toEqual(['trigger_type_not_built'])
        expect(problems[0].message).toContain(type)
      }
    }
  })

  it('refuses a type nobody has named as unknown', () => {
    expect(reasons({ type: 'carrier_pigeon', config: {} }, 'money')).toEqual(['trigger_type_unknown'])
    expect(reasons({ config: {} }, 'money')).toEqual(['trigger_type_unknown'])
    expect(reasons('http_webhook', 'money')).toEqual(['trigger_type_unknown'])
  })

  it('refuses an absent trigger as missing', () => {
    expect(reasons(undefined, 'money')).toEqual(['trigger_missing'])
    expect(reasons(null, 'ops')).toEqual(['trigger_missing'])
  })

  it('warns, without refusing, on the legacy webhook spelling stored versions still hold, and judges its config as an http webhook', () => {
    const legacy = { ...http(), type: 'webhook' }
    expect(validateTrigger(legacy, 'money').map((p) => [p.reason, p.severity])).toEqual([['trigger_legacy_spelling', 'warning']])
    const broken = { type: 'webhook', config: { method: 'POST' } }
    expect(reasons(broken, 'money')).toEqual(['trigger_legacy_spelling', 'trigger_config_invalid'])
  })

  it.each([
    ['a config that is not an object', { type: 'http_webhook', config: 'POST' }],
    ['no method', { type: 'http_webhook', config: { auth_method: 'api_key' } }],
    ['an auth method outside the list', http({ auth_method: 'basic' })],
    ['a duration alert that is not a positive number', http({ duration_alert_ms: '50000' })],
    ['a negative duration alert', http({ duration_alert_ms: -1 })],
    ['success namespaces that are not all strings', http({ success_node_namespaces: ['a', 3] })],
    ['muted signals that are not a list', http({ muted_failure_signals: { match: 'x' } })],
    ['a muted signal with no match', http({ muted_failure_signals: [{ count: 3, window_minutes: 5 }] })],
    ['idempotency whose enabled is not a boolean', http({ idempotency: { enabled: 'yes' } })],
  ])('refuses an http webhook with %s', (_, trigger) => {
    const problems = validateTrigger(trigger, 'money')
    expect(problems.map((p) => [p.reason, p.severity])).toEqual([['trigger_config_invalid', 'error']])
  })
})
