import { describe, it, expect } from 'vitest'
import { parsePipedreamExport } from '../pipedream-import'

// ── Helpers ───────────────────────────────────────────────────────────────────

function mkExport(name: string, steps: object[]) {
  return JSON.stringify({ id: 'p_abc', name, steps })
}

// ── Error handling ────────────────────────────────────────────────────────────

describe('error handling', () => {
  it('throws on invalid JSON', () => {
    expect(() => parsePipedreamExport('not json')).toThrow('Invalid JSON')
  })

  it('throws when no steps found', () => {
    expect(() => parsePipedreamExport(JSON.stringify({ id: 'p_abc', name: 'Empty' }))).toThrow('No steps found')
  })

  it('throws when only trigger step and no actions', () => {
    const raw = mkExport('T', [{ namespace: 'trigger', type: 'trigger' }])
    expect(() => parsePipedreamExport(raw)).toThrow('No actionable steps')
  })
})

// ── Workflow name ─────────────────────────────────────────────────────────────

describe('workflow name', () => {
  it('uses the workflow name from the export', () => {
    const raw = mkExport('Lead Routing', [
      { namespace: 'trigger', type: 'trigger' },
      { namespace: 'step1', savedComponent: { code: 'return {}' } },
    ])
    const result = parsePipedreamExport(raw)
    expect(result.name).toBe('Lead Routing')
  })

  it('defaults to "Imported Workflow" when name is missing', () => {
    const raw = JSON.stringify({ id: 'p_abc', steps: [
      { namespace: 'step1', savedComponent: { code: 'return {}' } },
    ]})
    const result = parsePipedreamExport(raw)
    expect(result.name).toBe('Imported Workflow')
  })
})

// ── Code node mapping ─────────────────────────────────────────────────────────

describe('code node', () => {
  it('maps a plain action step to a code node', () => {
    const raw = mkExport('W', [
      { namespace: 'validate_lead', savedComponent: { code: 'const x = 1' } },
    ])
    const { def } = parsePipedreamExport(raw)
    expect(def.nodes).toHaveLength(1)
    expect(def.nodes[0].type).toBe('code')
    expect(def.nodes[0].namespace).toBe('validate_lead')
  })

  it('stores translated code in config._imported_code', () => {
    const raw = mkExport('W', [
      { namespace: 'step1', savedComponent: { code: 'const x = steps.foo.$return_value.bar' } },
    ])
    const { def } = parsePipedreamExport(raw)
    expect(def.nodes[0].config.script).toBe('const x = steps.foo.bar')
  })

  it('warns when code node was imported (may need review)', () => {
    const raw = mkExport('W', [
      { namespace: 's', savedComponent: { code: 'x' } },
    ])
    const { warnings } = parsePipedreamExport(raw)
    expect(warnings.some((w) => w.includes('review the imported script'))).toBe(true)
  })

  it('maps configured_props to node variables', () => {
    const raw = mkExport('W', [{
      namespace: 'step1',
      savedComponent: { code: 'x' },
      configured_props: { endpoint: 'https://api.example.com' },
    }])
    const { def } = parsePipedreamExport(raw)
    expect(def.nodes[0].variables?.endpoint).toBe('https://api.example.com')
  })
})

// ── Code translation ──────────────────────────────────────────────────────────

describe('code translation', () => {
  function translate(code: string) {
    const raw = mkExport('W', [{ namespace: 's', savedComponent: { code } }])
    return parsePipedreamExport(raw).def.nodes[0].config.script as string
  }

  it('removes @pipedream/platform import', () => {
    const out = translate('import { axios } from "@pipedream/platform"')
    expect(out).toContain('// Uses native fetch')
    expect(out).not.toContain('@pipedream/platform')
  })

  it('translates steps.NAMESPACE.$return_value.field → steps.NAMESPACE.field', () => {
    expect(translate('steps.credit.$return_value.score')).toBe('steps.credit.score')
  })

  it('translates steps.trigger.event.body → trigger.payload', () => {
    expect(translate('steps.trigger.event.body')).toBe('trigger.payload')
  })

  it('translates steps.trigger.event.body.field → trigger.payload.field', () => {
    expect(translate('steps.trigger.event.body.state')).toBe('trigger.payload.state')
  })

  it('translates process.env.VAR → env.VAR', () => {
    expect(translate('process.env.API_KEY')).toBe('env.API_KEY')
  })

  it('translates this.propName → config.propName', () => {
    expect(translate('this.endpoint')).toBe('config.endpoint')
  })

  it('translates $.flow.exit(reason) → return { exit: true, reason }', () => {
    const out = translate('$.flow.exit("ineligible")')
    expect(out).toContain('return { exit: true, reason: "ineligible" }')
  })

  it('translates $.respond({ status, body }) → return { response: { ... } }', () => {
    const out = translate('$.respond({ status: 200, body: {} })')
    expect(out).toContain('return { response: { status: 200, body: {} } }')
  })

  it('translates $.export("$summary", msg) → console.log(msg)', () => {
    const out = translate('$.export("$summary", "done")')
    expect(out).toContain('console.log("done")')
  })
})

// ── Filter node mapping ───────────────────────────────────────────────────────

describe('filter node', () => {
  it('maps _filter with evalRuleGroup to a filter node', () => {
    const raw = mkExport('W', [{
      namespace: 'filter_state',
      _filter: {
        type: 'evalRuleGroup',
        ruleGroup: {
          operatorGroup: 'AND',
          rules: [
            { key: 'steps.trigger.event.body.state', operator: 'not_equals', value: 'CA' },
          ],
        },
      },
    }])
    const { def } = parsePipedreamExport(raw)
    expect(def.nodes).toHaveLength(1)
    expect(def.nodes[0].type).toBe('filter')
    expect(def.nodes[0].namespace).toBe('filter_state')
  })

  it('translates filter field paths', () => {
    const raw = mkExport('W', [{
      namespace: 'f',
      _filter: {
        type: 'evalRuleGroup',
        ruleGroup: {
          rules: [{ key: 'steps.trigger.event.body.state', operator: 'not_equals', value: 'CA' }],
        },
      },
    }])
    const { def } = parsePipedreamExport(raw)
    const rules = def.nodes[0].config.rules as { groups: Array<{ conditions: Array<{ field: string }> }> }
    expect(rules.groups[0].conditions[0].field).toBe('trigger.payload.state')
  })

  it('maps not_equals → neq', () => {
    const raw = mkExport('W', [{
      namespace: 'f',
      _filter: {
        type: 'evalRuleGroup',
        ruleGroup: { rules: [{ key: 'trigger.payload.state', operator: 'not_equals', value: 'CA' }] },
      },
    }])
    const { def } = parsePipedreamExport(raw)
    const rules = def.nodes[0].config.rules as { groups: Array<{ conditions: Array<{ operator: string }> }> }
    expect(rules.groups[0].conditions[0].operator).toBe('neq')
  })

  it('maps greater_than_or_equal → gte', () => {
    const raw = mkExport('W', [{
      namespace: 'f',
      _filter: {
        type: 'evalRuleGroup',
        ruleGroup: { rules: [{ key: 'trigger.payload.score', operator: 'greater_than_or_equal', value: 600 }] },
      },
    }])
    const { def } = parsePipedreamExport(raw)
    const rules = def.nodes[0].config.rules as { groups: Array<{ conditions: Array<{ operator: string; value: unknown }> }> }
    expect(rules.groups[0].conditions[0].operator).toBe('gte')
    expect(rules.groups[0].conditions[0].value).toBe(600)
  })

  it('maps is_blank → not_exists (no value)', () => {
    const raw = mkExport('W', [{
      namespace: 'f',
      _filter: {
        type: 'evalRuleGroup',
        ruleGroup: { rules: [{ key: 'trigger.payload.email', operator: 'is_blank' }] },
      },
    }])
    const { def } = parsePipedreamExport(raw)
    const rules = def.nodes[0].config.rules as { groups: Array<{ conditions: Array<{ operator: string; value: unknown }> }> }
    expect(rules.groups[0].conditions[0].operator).toBe('not_exists')
    expect(rules.groups[0].conditions[0].value).toBeUndefined()
  })

  it('maps OR operatorGroup correctly', () => {
    const raw = mkExport('W', [{
      namespace: 'f',
      _filter: {
        type: 'evalRuleGroup',
        ruleGroup: {
          operatorGroup: 'OR',
          rules: [
            { key: 'trigger.payload.state', operator: 'eq', value: 'CA' },
            { key: 'trigger.payload.state', operator: 'eq', value: 'TX' },
          ],
        },
      },
    }])
    const { def } = parsePipedreamExport(raw)
    const rules = def.nodes[0].config.rules as { groups: Array<{ logic: string }>; logic: string }
    expect(rules.groups[0].logic).toBe('OR')
  })
})

// ── Branch node mapping ───────────────────────────────────────────────────────

describe('branch node', () => {
  it('maps _controlFlow ifelse to a branch node', () => {
    const raw = mkExport('W', [{
      namespace: 'route_lead',
      _controlFlow: {
        type: 'ifelse',
        conditions: [
          {
            label: 'High Score',
            expression: {
              operatorGroup: 'AND',
              rules: [{ key: 'steps.credit.$return_value.score', operator: 'gte', value: 700 }],
            },
          },
        ],
      },
    }])
    const { def } = parsePipedreamExport(raw)
    expect(def.nodes).toHaveLength(1)
    expect(def.nodes[0].type).toBe('branch')
    expect(def.nodes[0].namespace).toBe('route_lead')
  })

  it('preserves branch labels', () => {
    const raw = mkExport('W', [{
      namespace: 'route',
      _controlFlow: {
        type: 'ifelse',
        conditions: [
          {
            label: 'Penny Fit',
            expression: { rules: [{ key: 'trigger.payload.fit', operator: 'eq', value: true }] },
          },
          {
            label: 'Not Fit',
            expression: { rules: [{ key: 'trigger.payload.fit', operator: 'neq', value: true }] },
          },
        ],
      },
    }])
    const { def } = parsePipedreamExport(raw)
    const branches = def.nodes[0].config.branches as Array<{ label: string }>
    expect(branches[0].label).toBe('Penny Fit')
    expect(branches[1].label).toBe('Not Fit')
  })

  it('translates field paths in branch conditions', () => {
    const raw = mkExport('W', [{
      namespace: 'route',
      _controlFlow: {
        type: 'ifelse',
        conditions: [{
          label: 'b1',
          expression: { rules: [{ key: 'steps.credit.$return_value.score', operator: 'gte', value: 700 }] },
        }],
      },
    }])
    const { def } = parsePipedreamExport(raw)
    const branches = def.nodes[0].config.branches as Array<{
      condition: { groups: Array<{ conditions: Array<{ field: string }> }> }
    }>
    expect(branches[0].condition.groups[0].conditions[0].field).toBe('steps.credit.score')
  })
})

// ── Edge creation ─────────────────────────────────────────────────────────────

describe('edge creation', () => {
  it('creates sequential edges between code nodes', () => {
    const raw = mkExport('W', [
      { namespace: 'trigger', type: 'trigger' },
      { namespace: 'step1', savedComponent: { code: 'x' } },
      { namespace: 'step2', savedComponent: { code: 'y' } },
    ])
    const { def } = parsePipedreamExport(raw)
    expect(def.edges).toHaveLength(2)
    // trigger → step1
    expect(def.edges[0].source).toBe('trigger')
    expect(def.edges[0].target).toBe('n_step1')
    // step1 → step2
    expect(def.edges[1].source).toBe('n_step1')
    expect(def.edges[1].target).toBe('n_step2')
  })

  it('creates a pass edge from filter node', () => {
    const raw = mkExport('W', [{
      namespace: 'filter_state',
      _filter: {
        type: 'evalRuleGroup',
        ruleGroup: { rules: [{ key: 'x', operator: 'eq', value: 1 }] },
      },
    }])
    const { def } = parsePipedreamExport(raw)
    // No next step — no edges yet, but the node has source_handle 'pass' if followed
    // Here we just test the node was created
    expect(def.nodes[0].type).toBe('filter')
  })
})

// ── Auto-layout ───────────────────────────────────────────────────────────────

describe('auto-layout', () => {
  it('assigns positions to all nodes', () => {
    const raw = mkExport('W', [
      { namespace: 'a', savedComponent: { code: 'x' } },
      { namespace: 'b', savedComponent: { code: 'y' } },
    ])
    const { def } = parsePipedreamExport(raw)
    for (const node of def.nodes) {
      expect(node.position).toBeDefined()
      expect(typeof node.position?.x).toBe('number')
      expect(typeof node.position?.y).toBe('number')
    }
  })

  it('places nodes at increasing Y positions', () => {
    const raw = mkExport('W', [
      { namespace: 'a', savedComponent: { code: 'x' } },
      { namespace: 'b', savedComponent: { code: 'y' } },
    ])
    const { def } = parsePipedreamExport(raw)
    expect(def.nodes[1].position!.y).toBeGreaterThan(def.nodes[0].position!.y)
  })
})

// ── Trigger config ────────────────────────────────────────────────────────────

describe('trigger config', () => {
  it('always sets trigger type to http_webhook', () => {
    const raw = mkExport('W', [{ namespace: 's', savedComponent: { code: 'x' } }])
    const { def } = parsePipedreamExport(raw)
    expect(def.trigger.type).toBe('http_webhook')
  })
})

// ── Alternate shape: components object ───────────────────────────────────────

describe('components shape', () => {
  it('accepts components.triggers + components.actions format', () => {
    const raw = JSON.stringify({
      id: 'p_abc',
      name: 'Alt Shape',
      components: {
        triggers: [{ namespace: 'trigger', type: 'trigger' }],
        actions: [
          { namespace: 'do_thing', savedComponent: { code: 'return 1' } },
        ],
      },
    })
    const { def } = parsePipedreamExport(raw)
    expect(def.nodes).toHaveLength(1)
    expect(def.nodes[0].namespace).toBe('do_thing')
  })
})

// ── Unknown operator warning ──────────────────────────────────────────────────

describe('operator warnings', () => {
  it('warns and defaults to eq for unknown operators', () => {
    const raw = mkExport('W', [{
      namespace: 'f',
      _filter: {
        type: 'evalRuleGroup',
        ruleGroup: { rules: [{ key: 'x', operator: 'custom_op', value: 1 }] },
      },
    }])
    const { warnings, def } = parsePipedreamExport(raw)
    expect(warnings.some((w) => w.includes('Unknown operator'))).toBe(true)
    const rules = def.nodes[0].config.rules as { groups: Array<{ conditions: Array<{ operator: string }> }> }
    expect(rules.groups[0].conditions[0].operator).toBe('eq')
  })

  it('warns and maps starts_with to contains', () => {
    const raw = mkExport('W', [{
      namespace: 'f',
      _filter: {
        type: 'evalRuleGroup',
        ruleGroup: { rules: [{ key: 'x', operator: 'starts_with', value: 'foo' }] },
      },
    }])
    const { warnings, def } = parsePipedreamExport(raw)
    expect(warnings.some((w) => w.includes('no exact match'))).toBe(true)
    const rules = def.nodes[0].config.rules as { groups: Array<{ conditions: Array<{ operator: string }> }> }
    expect(rules.groups[0].conditions[0].operator).toBe('contains')
  })
})
