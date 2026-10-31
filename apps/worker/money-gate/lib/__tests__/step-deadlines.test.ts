import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GATE_STEP_DEADLINE_MS, keepStepDeadlines, liftStepDeadlines } from '../step-deadlines'

interface Def { id: string; name: string; definition: { nodes: Array<{ namespace: string; type: string; config?: Record<string, unknown> }>; edges: unknown[] } }

const definitionsDir = resolve(__dirname, '../../fixtures/definitions')
const committed: Def[] = readdirSync(definitionsDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(resolve(definitionsDir, f), 'utf8')) as Def)

const def = (nodes: Def['definition']['nodes']): Def => ({ id: 'w', name: 'W', definition: { nodes, edges: [] } })

describe('liftStepDeadlines (#1796)', () => {
  it('lifts a short configured timeout to the gate deadline', () => {
    const out = liftStepDeadlines(def([{ namespace: 'build_response_body', type: 'code', config: { script: 'return 1', timeout_ms: 250, retries: 2 } }]))
    expect(out.definition.nodes[0].config).toEqual({ script: 'return 1', timeout_ms: GATE_STEP_DEADLINE_MS, retries: 2 })
  })

  it('never adds a timeout to a node that has none, because a custom timeout keeps a code node out of a chain', () => {
    const out = liftStepDeadlines(def([
      { namespace: 'a', type: 'code', config: { script: 'return 1' } },
      { namespace: 'b', type: 'branch' },
    ]))
    expect('timeout_ms' in (out.definition.nodes[0].config ?? {})).toBe(false)
    expect(out.definition.nodes[1].config).toBeUndefined()
  })

  it('lifts every timer field a node reads, the bid group total included', () => {
    const out = liftStepDeadlines(def([{ namespace: 'bid_race', type: 'bid_group', config: { timeout_ms: 46750, cascade_total_timeout_ms: 30000 } }]))
    expect(out.definition.nodes[0].config).toEqual({ timeout_ms: GATE_STEP_DEADLINE_MS, cascade_total_timeout_ms: GATE_STEP_DEADLINE_MS })
  })

  it('leaves the fixture it was given untouched, so the definitions stay as committed', () => {
    const input = def([{ namespace: 'x', type: 'code', config: { timeout_ms: 150 } }])
    liftStepDeadlines(input)
    expect(input.definition.nodes[0].config?.timeout_ms).toBe(150)
  })

  it('leaves no committed definition with a step deadline a slow runner could reach', () => {
    // The quantity the gate depends on: no timer in any replayed definition can fire
    // inside the time a real replay takes, so a retry can never come from load.
    const short: string[] = []
    for (const d of committed.map(liftStepDeadlines)) {
      for (const n of d.definition.nodes) {
        for (const [field, value] of Object.entries(n.config ?? {})) {
          if (/timeout_ms$/.test(field) && typeof value === 'number' && value < GATE_STEP_DEADLINE_MS) short.push(`${d.name}/${n.namespace}.${field}=${value}`)
        }
      }
    }
    expect(short).toEqual([])
    // And there was something to lift: the committed definitions carry short timeouts.
    const before = committed.flatMap((d) => d.definition.nodes).filter((n) => typeof n.config?.timeout_ms === 'number' && (n.config.timeout_ms as number) < 1000)
    expect(before.length).toBeGreaterThan(0)
  })

  it('sets the deadline far above any real replay step, and below the replay test timeout', () => {
    expect(GATE_STEP_DEADLINE_MS).toBeGreaterThanOrEqual(60_000)
    expect(GATE_STEP_DEADLINE_MS).toBeLessThan(900_000)
  })
})

// A fixture can keep a step's own per attempt deadline (#3138), so an attempt can
// time out on the replay's time and its retry run, as production's would.
describe('keepStepDeadlines (#3138)', () => {
  const defined = def([
    { namespace: 'tripoint_sf_post', type: 'webhook', config: { url: 'https://relay.example', retries: 2, timeout_ms: 3750 } },
    { namespace: 'other_post', type: 'webhook', config: { timeout_ms: 5000 } },
    { namespace: 'build_body', type: 'code', config: { script: 'return 1', timeout_ms: 250 } },
    { namespace: 'route', type: 'branch' },
  ])
  const lifted = liftStepDeadlines(defined)

  it('gives back the named step its defined deadline and leaves every other step lifted', () => {
    const out = keepStepDeadlines(lifted, defined, ['tripoint_sf_post'])
    expect(out.definition.nodes[0].config).toEqual({ url: 'https://relay.example', retries: 2, timeout_ms: 3750 })
    expect(out.definition.nodes[1].config?.timeout_ms).toBe(GATE_STEP_DEADLINE_MS)
    expect(out.definition.nodes[2].config?.timeout_ms).toBe(GATE_STEP_DEADLINE_MS)
    expect(lifted.definition.nodes[0].config?.timeout_ms).toBe(GATE_STEP_DEADLINE_MS)
  })

  it('changes nothing when no step is named', () => {
    expect(keepStepDeadlines(lifted, defined, [])).toEqual(lifted)
  })

  it('refuses by name a step the definition does not have', () => {
    expect(() => keepStepDeadlines(lifted, defined, ['no_such_step'])).toThrow(/no_such_step/)
  })

  it('refuses by name a step that sets no deadline, since there is nothing to keep', () => {
    expect(() => keepStepDeadlines(lifted, defined, ['route'])).toThrow(/route.*no timeout_ms/)
  })

  it('refuses by name a code step, whose dispatch takes real time a kept deadline would race', () => {
    expect(() => keepStepDeadlines(lifted, defined, ['build_body'])).toThrow(/build_body.*code/)
  })

  it('keeps the Main Flow outcome relay post the timed out attempt fixtures name at its committed 3,750 ms', () => {
    const mainFlow = committed.find((d) => d.name === 'Main Flow')!
    const out = keepStepDeadlines(liftStepDeadlines(mainFlow), mainFlow, ['tripoint_sf_post'])
    expect(out.definition.nodes.find((n) => n.namespace === 'tripoint_sf_post')!.config).toMatchObject({ timeout_ms: 3750, retries: 2 })
  })
})
